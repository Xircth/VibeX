import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentManagementApi } from '@/features/agent-management';
import { localUsageApi } from '@/lib/api';
import { KanbanUsageDashboard } from './KanbanUsageDashboard';

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [{ id: 'project-1', name: 'VibeX' }],
  }),
}));

vi.mock('@/lib/api', () => ({
  localUsageApi: {
    getProjectStatistics: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    authMode: vi.fn().mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      mode:
        agentId === 'codex' ? 'chatgpt_subscription' : 'official_subscription',
      modes: [
        agentId === 'codex' ? 'chatgpt_subscription' : 'official_subscription',
      ],
      options: [],
      credential_env: '',
      credential_present: true,
    })),
    planUsage: vi.fn().mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    }),
    runAction: vi.fn().mockResolvedValue({}),
  },
  agentManagementErrorMessage: (_error: unknown, fallback: string) => fallback,
  useAgentManagement: () => ({
    loading: false,
    state: {
      agents: [
        {
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          description: 'Claude',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 0,
          lifecycle: 'ready',
          authentication: 'account',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
        {
          agent_id: 'codex',
          display_name: 'Codex',
          description: 'Codex',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 1,
          lifecycle: 'ready',
          authentication: 'account',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
      ],
    },
  }),
}));

const sourced = (total: number) => ({
  protocol: {
    input_tokens: total / 2,
    output_tokens: total / 2,
    cache_write_tokens: 0,
    cache_read_tokens: total === 250 ? 80 : 40,
    total_tokens: total,
  },
  vendor_log: null,
  sources_disagree: false,
});

describe('KanbanUsageDashboard', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue(
      null as never
    );
    vi.mocked(agentManagementApi.planUsage).mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    } as never);
  });

  it('loads the selected range once instead of prefetching every target', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 0,
      total_tokens: {
        protocol: null,
        vendor_log: null,
        sources_disagree: false,
      },
      estimated_cost: null,
      sessions: [],
      daily_usage: [],
      weekly_comparison: {
        current_week: { sessions: 0, cost: null, tokens: null },
        last_week: { sessions: 0, cost: null, tokens: null },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      by_model: [],
      by_folder: [],
      by_agent: [],
      provider_status: [],
      unattributed_vendor_sessions: 0,
      last_updated: Date.now(),
      pricing_notice: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole('region', { name: '用量摘要' })
    ).toBeVisible();
    expect(localUsageApi.getProjectStatistics).toHaveBeenCalledTimes(1);
  });

  it('shows the settings surface skeleton while usage statistics load', () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockReturnValue(
      new Promise(() => undefined)
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    const status = screen.getByRole('status', { name: '加载中...' });
    expect(status).toHaveClass('agent-settings-loading');
    expect(status.querySelectorAll('.settings-surface')).toHaveLength(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('keeps plan usage available in the left navigation', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    const planButton = screen.getByRole('button', { name: '套餐' });

    expect(planButton).toBeVisible();
    fireEvent.click(planButton);

    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('shows cache efficiency and daily token breakdowns in overview', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 2,
      total_tokens: {
        protocol: {
          input_tokens: 100,
          output_tokens: 50,
          cache_write_tokens: 20,
          cache_read_tokens: 80,
          total_tokens: 250,
        },
        vendor_log: null,
        sources_disagree: false,
      },
      estimated_cost: 0.42,
      sessions: [
        {
          session_id: 'session-1',
          workspace_id: 'ws-1',
          timestamp: new Date(2026, 8, 1, 15).getTime(),
          model: 'claude-sonnet-4',
          tokens: sourced(150),
          cost: 0.3,
          summary: 'First session',
        },
        {
          session_id: 'session-2',
          workspace_id: 'ws-1',
          timestamp: new Date(2026, 8, 2, 9).getTime(),
          model: 'claude-sonnet-4',
          tokens: sourced(100),
          cost: 0.12,
          summary: 'Second session',
        },
      ],
      daily_usage: [
        {
          date: '2026-09-01',
          sessions: 1,
          tokens: sourced(150),
          cost: 0.3,
          models_used: ['claude-sonnet-4'],
        },
        {
          date: '2026-09-02',
          sessions: 1,
          tokens: sourced(100),
          cost: 0.12,
          models_used: ['claude-sonnet-4'],
          turns: 4,
        },
      ],
      weekly_comparison: {
        current_week: { sessions: 2, cost: 0.42, tokens: 250 },
        last_week: { sessions: 1, cost: 0.2, tokens: 100 },
        trends: { sessions: 100, cost: 110, tokens: 150 },
      },
      by_model: [
        {
          model: 'claude-sonnet-4',
          cost: 0.42,
          tokens: sourced(250),
          session_count: 2,
        },
        {
          model: 'gpt-5.1',
          cost: 0.21,
          tokens: sourced(120),
          session_count: 1,
        },
        {
          model: 'gemini-2.5-pro',
          cost: 0.1,
          tokens: sourced(80),
          session_count: 1,
        },
        {
          model: 'deepseek-r1',
          cost: 0.05,
          tokens: sourced(60),
          session_count: 1,
        },
        {
          model: 'qwen-max',
          cost: 0.04,
          tokens: sourced(40),
          session_count: 1,
        },
        {
          model: 'opus',
          cost: 9,
          tokens: sourced(900),
          session_count: 9,
        },
        {
          model: 'fable',
          cost: 8,
          tokens: sourced(800),
          session_count: 8,
        },
        {
          model: 'llama-4',
          cost: 0.02,
          tokens: sourced(20),
          session_count: 1,
        },
      ],
      by_folder: [
        {
          workspace_id: 'ws-1',
          folder: '/repo',
          session_count: 2,
          tokens: sourced(250),
          cost: 0.42,
        },
      ],
      by_agent: [
        {
          agent_id: 'claude_code',
          session_count: 2,
          tokens: sourced(250),
          cost: 0.42,
        },
      ],
      provider_status: [],
      unattributed_vendor_sessions: 0,
      last_updated: Date.now(),
      pricing_notice: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole('img', { name: '缓存命中率: 40%' })
    ).toBeVisible();
    expect(container.querySelector('.kanban-usage-page')).not.toBeNull();

    const summary = screen.getByRole('region', { name: '用量摘要' });
    expect(within(summary).getByText('250')).toHaveClass(
      'kanban-usage-stat__value'
    );
    expect(within(summary).getByText('$0.4200')).toHaveClass(
      'kanban-usage-stat__value--compact'
    );
    expect(
      within(summary)
        .getByRole('img', { name: '缓存命中率: 40%' })
        .closest('.kanban-usage-summary__ring')
    ).not.toBeNull();
    expect(within(summary).queryByText('缓存命中率')).not.toBeInTheDocument();
    expect(
      within(summary).queryByText(/80\s*缓存读取/)
    ).not.toBeInTheDocument();
    expect(
      within(summary).getByRole('heading', { name: 'Token统计与缓存率' })
    ).toBeVisible();
    expect(
      within(summary).getByRole('heading', { name: '统计信息' })
    ).toBeVisible();
    expect(
      within(summary).getByRole('heading', { name: '用户习惯' })
    ).toBeVisible();
    expect(within(summary).getByText('总费用')).toBeVisible();
    expect(within(summary).getByText('总会话')).toBeVisible();
    expect(within(summary).getByText('平均/会话')).toBeVisible();
    expect(within(summary).getByText('活跃天数')).toBeVisible();
    expect(within(summary).getByText('$0.4200')).toBeVisible();
    expect(within(summary).getByText('平均每次 125 Token')).toBeVisible();

    expect(
      screen.queryByText(/Claude 缓存写入默认按 5 分钟档处理/)
    ).not.toBeInTheDocument();

    const lastUpdated = screen.getByText(/最后更新：/);
    const projectSelector = screen.getByRole('combobox', { name: '当前项目' });
    expect(lastUpdated.parentElement).toContainElement(projectSelector);

    const refreshButton = screen.getByRole('button', { name: '刷新' });
    expect(refreshButton).toHaveTextContent('刷新');
    expect(refreshButton).toHaveClass('astryx-button');

    const dateRangeButton = screen.getByRole('button', { name: '7天' });
    expect(dateRangeButton.parentElement).toHaveClass('h-8');

    expect(within(summary).getByText('活跃工作时段')).toBeVisible();
    expect(within(summary).getByText('15:00 - 16:00')).toBeVisible();
    expect(within(summary).getByText('日均 Token 用量')).toBeVisible();
    expect(within(summary).getByText('125')).toBeVisible();
    expect(within(summary).queryByText('仅活跃日期')).not.toBeInTheDocument();
    expect(within(summary).getByText('最爱用的 Agent')).toBeVisible();
    const favoriteTile = within(summary)
      .getByText('最爱用的 Agent')
      .closest('div.rounded-lg') as HTMLElement;
    const favoriteName = within(favoriteTile).getByText('Claude Code', {
      selector: 'span',
    });
    expect(favoriteName).toBeVisible();
    expect(favoriteName.closest('strong')?.querySelector('svg')).not.toBeNull();
    expect(within(summary).queryByText('claude_code')).not.toBeInTheDocument();
    expect(within(summary).getByText('最爱用的模型')).toBeVisible();
    expect(within(summary).getByText('claude-sonnet-4')).toBeVisible();

    const allCardTitles = [
      'Token统计与缓存率',
      '统计信息',
      '用户习惯',
      '用量趋势',
      'Token 构成',
      '常用模型',
      '活跃热力图',
      '常用项目',
      '常用Agent',
    ];
    for (const title of allCardTitles) {
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.querySelector('svg')).not.toBeNull();
    }

    const trendHeading = screen.getByRole('heading', { name: '用量趋势' });
    const compositionHeading = screen.getByRole('heading', {
      name: 'Token 构成',
    });
    const trendCard = trendHeading.closest('section');
    const compositionCard = compositionHeading.closest('section');
    expect(trendCard?.parentElement).toBe(compositionCard?.parentElement);
    expect(trendCard?.nextElementSibling).toBe(compositionCard);

    const modelsHeading = screen.getByRole('heading', { name: '常用模型' });
    const heatmapHeading = screen.getByRole('heading', { name: '活跃热力图' });
    const modelsCard = modelsHeading.closest('section') as HTMLElement;
    const heatmapCard = heatmapHeading.closest('section');
    expect(modelsCard?.parentElement).toBe(heatmapCard?.parentElement);
    expect(modelsCard?.nextElementSibling).toBe(heatmapCard);
    expect(
      modelsCard.querySelector('.kanban-usage-ranking-list')
    ).not.toBeNull();
    expect(within(modelsCard).getByText('llama-4')).toBeInTheDocument();
    expect(within(modelsCard).queryByText('opus')).toBeNull();
    expect(within(modelsCard).queryByText('fable')).toBeNull();
    expect(within(modelsCard).getByText('1')).toHaveClass('kanban-rank-first');
    expect(within(modelsCard).getByText('2')).toHaveClass('kanban-rank-second');
    expect(within(modelsCard).getByText('3')).toHaveClass('kanban-rank-third');

    const projectsHeading = screen.getByRole('heading', { name: '常用项目' });
    const agentsHeading = screen.getByRole('heading', { name: '常用Agent' });
    const projectsCard = projectsHeading.closest('section');
    const agentsCard = agentsHeading.closest('section');
    expect(projectsCard?.parentElement).toBe(agentsCard?.parentElement);
    expect(projectsCard?.nextElementSibling).toBe(agentsCard);
    expect(
      within(projectsCard as HTMLElement).getByText('/repo')
    ).toBeVisible();
    expect(
      within(agentsCard as HTMLElement).getByText('claude_code')
    ).toBeVisible();

    const trendLineSvg = screen.getByTestId('usage-trend-line-chart');
    expect(trendLineSvg).toBeInTheDocument();
    expect(trendLineSvg.querySelector('polyline')).toHaveAttribute(
      'stroke',
      'var(--usage-blue-fg)'
    );

    const metricPills = modelsCard.querySelectorAll(
      '.kanban-usage-metric-pill'
    );
    expect(metricPills.length).toBeGreaterThanOrEqual(3);
    expect(metricPills[0].className).toBe(metricPills[1].className);
    expect(metricPills[1].className).toBe(metricPills[2].className);

    const dailyBar = screen.getByRole('button', {
      name: '09-02，共 100 Token',
    });
    fireEvent.mouseEnter(dailyBar);

    const trendTooltip = screen.getByTestId('usage-trend-tooltip');
    expect(within(trendTooltip).getByText('9月2日周三')).toBeVisible();
    expect(within(trendTooltip).getAllByText('100').length).toBeGreaterThan(0);
    expect(within(trendTooltip).getByText('缓存读取')).toBeVisible();
    expect(within(trendTooltip).getByText('40')).toBeVisible();
    expect(within(trendTooltip).getByText('新算 Token')).toBeVisible();
    expect(within(trendTooltip).getByText('60')).toBeVisible();
    expect(within(trendTooltip).getByText('轮次')).toBeVisible();
    expect(within(trendTooltip).getByText('4')).toBeVisible();
    expect(within(trendTooltip).getByText('会话')).toBeVisible();
    expect(within(trendTooltip).getByText('1')).toBeVisible();
    expect(within(trendTooltip).queryByText('趋势折线')).toBeNull();
    expect(within(trendTooltip).queryByText('$0.1200')).toBeNull();
    const trendLegend = screen.getByText('趋势折线').parentElement;
    expect(trendLegend?.querySelector('[class*="amber"]')).toBeNull();
    expect(trendLegend?.innerHTML).toContain('--usage-blue-fg');
    fireEvent.mouseLeave(dailyBar);

    const heatmapCell = screen.getByRole('img', {
      name: '二 15:00，150 Token',
    });
    expect(heatmapCell).toHaveClass('aspect-[4/3]', 'rounded-[3px]');
    fireEvent.mouseEnter(heatmapCell);

    expect(screen.getByRole('tooltip')).toHaveTextContent('二 15:00');
    expect(screen.getByRole('tooltip')).toHaveTextContent('150 Token');

    fireEvent.click(screen.getByRole('button', { name: '目录' }));
    const folderButton = screen.getByRole('button', { name: /\/repo/ });
    expect(folderButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(folderButton);
    expect(folderButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('平均日 Token')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Token 构成' })).toBeVisible();
  });

  it('resolves Grok cost and falls back to protocol tokens when vendor_log has empty token counts', async () => {
    const emptyVendorCounts = {
      input_tokens: null,
      output_tokens: null,
      cache_write_tokens: null,
      cache_read_tokens: null,
      total_tokens: null,
    };
    const grokProtocolCounts = {
      input_tokens: 500_000,
      output_tokens: 100_000,
      cache_write_tokens: 0,
      cache_read_tokens: 400_000,
      total_tokens: 1_000_000,
    };

    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 1,
      total_tokens: {
        protocol: grokProtocolCounts,
        vendor_log: emptyVendorCounts,
        sources_disagree: false,
      },
      estimated_cost: null,
      sessions: [
        {
          session_id: 'grok-session-1',
          workspace_id: 'ws-grok',
          folder: 'C:\\projects\\VibeX',
          agent_id: 'grok',
          timestamp: new Date(2026, 8, 18, 10).getTime(),
          model: 'grok-4.6',
          tokens: {
            protocol: grokProtocolCounts,
            vendor_log: emptyVendorCounts,
            sources_disagree: false,
          },
          cost: null,
          summary: 'Grok optimization session',
        },
      ],
      daily_usage: [
        {
          date: '2026-09-18',
          sessions: 1,
          tokens: {
            protocol: grokProtocolCounts,
            vendor_log: emptyVendorCounts,
            sources_disagree: false,
          },
          cost: null,
          models_used: ['grok-4.6'],
        },
      ],
      weekly_comparison: {
        current_week: { sessions: 1, cost: null, tokens: 1_000_000 },
        last_week: { sessions: 0, cost: null, tokens: null },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      by_model: [
        {
          model: 'grok-4.6',
          cost: null,
          tokens: {
            protocol: grokProtocolCounts,
            vendor_log: emptyVendorCounts,
            sources_disagree: false,
          },
          session_count: 1,
        },
      ],
      by_folder: [
        {
          workspace_id: 'ws-grok',
          folder: 'C:\\projects\\VibeX',
          session_count: 1,
          tokens: {
            protocol: grokProtocolCounts,
            vendor_log: emptyVendorCounts,
            sources_disagree: false,
          },
          cost: null,
        },
      ],
      by_agent: [
        {
          agent_id: 'grok',
          session_count: 1,
          tokens: {
            protocol: grokProtocolCounts,
            vendor_log: emptyVendorCounts,
            sources_disagree: false,
          },
          cost: null,
        },
      ],
      provider_status: [],
      unattributed_vendor_sessions: 0,
      last_updated: Date.now(),
      pricing_notice: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    const summary = await screen.findByRole('region', { name: '用量摘要' });
    // grok-4.6 rate: 0.5M * $2 + 0.1M * $6 + 0.4M * $0.5 = $1.0 + $0.6 + $0.2 = $1.8000
    expect(within(summary).getAllByText('$1.8000').length).toBeGreaterThan(0);
    expect(within(summary).getAllByText('1.0M').length).toBeGreaterThan(0);

    const modelsCard = screen
      .getByRole('heading', { name: '常用模型' })
      .closest('section') as HTMLElement;
    expect(within(modelsCard).getByText('grok-4.6')).toBeVisible();
    expect(within(modelsCard).getByText('$1.8000')).toBeVisible();
    expect(within(modelsCard).getByText('1.0M Token')).toBeVisible();
  });

  it('renders missing token breakdowns as 未提供 instead of zero', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 1,
      total_tokens: {
        protocol: null,
        vendor_log: null,
        sources_disagree: false,
      },
      estimated_cost: null,
      sessions: [
        {
          session_id: 'kimi-1',
          workspace_id: 'ws-2',
          folder: '/repo/.worktrees/a',
          agent_id: 'kimi',
          timestamp: Date.now(),
          model: null,
          tokens: { protocol: null, vendor_log: null, sources_disagree: false },
          cost: null,
          summary: 'Kimi session',
        },
      ],
      daily_usage: [],
      weekly_comparison: {
        current_week: { sessions: 1, cost: null, tokens: null },
        last_week: { sessions: 0, cost: null, tokens: null },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      by_model: [],
      by_folder: [
        {
          workspace_id: 'ws-2',
          folder: '/repo/.worktrees/a',
          session_count: 1,
          tokens: { protocol: null, vendor_log: null, sources_disagree: false },
          cost: null,
        },
      ],
      by_agent: [
        {
          agent_id: 'kimi',
          session_count: 1,
          tokens: { protocol: null, vendor_log: null, sources_disagree: false },
          cost: null,
        },
      ],
      provider_status: [],
      unattributed_vendor_sessions: 0,
      last_updated: Date.now(),
      pricing_notice: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    expect(await screen.findAllByText('未提供')).not.toHaveLength(0);
    expect(screen.getByText(/未通过协议提供/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('kimi')).toBeVisible();
    expect(screen.getAllByText('未提供').length).toBeGreaterThan(0);
  });

  it('uses vendor log tokens as standard when both protocol and vendor log exist and hides unattributed notices', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 1,
      total_tokens: {
        protocol: {
          input_tokens: 50,
          output_tokens: 50,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 100,
        },
        vendor_log: {
          input_tokens: 100,
          output_tokens: 50,
          cache_write_tokens: 20,
          cache_read_tokens: 80,
          total_tokens: 250,
        },
        sources_disagree: true,
      },
      estimated_cost: 0.2,
      sessions: [
        {
          session_id: 'codex-1',
          workspace_id: 'ws-1',
          timestamp: new Date(2026, 8, 1, 15).getTime(),
          model: 'gpt-5.1',
          tokens: {
            protocol: null,
            vendor_log: {
              input_tokens: 100,
              output_tokens: 50,
              cache_write_tokens: 20,
              cache_read_tokens: 80,
              total_tokens: 250,
            },
            sources_disagree: false,
          },
          cost: 0.2,
          summary: 'Codex session',
        },
      ],
      daily_usage: [
        {
          date: '2026-09-01',
          sessions: 1,
          tokens: {
            protocol: null,
            vendor_log: {
              input_tokens: 100,
              output_tokens: 50,
              cache_write_tokens: 20,
              cache_read_tokens: 80,
              total_tokens: 250,
            },
            sources_disagree: false,
          },
          cost: 0.2,
          models_used: ['gpt-5.1'],
        },
      ],
      weekly_comparison: {
        current_week: { sessions: 1, cost: 0.2, tokens: 250 },
        last_week: { sessions: 0, cost: null, tokens: null },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      by_model: [],
      by_folder: [],
      by_agent: [],
      provider_status: [],
      unattributed_vendor_sessions: 132,
      last_updated: Date.now(),
      pricing_notice: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole('img', { name: '缓存命中率: 40%' })
    ).toBeVisible();
    expect(
      screen.getByRole('img', { name: '二 15:00，250 Token' })
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '用量摘要' })).getAllByText(
        '250'
      )
    ).toHaveLength(2);
    expect(screen.queryByText(/协议 .* · 厂商日志/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/条厂商日志未能对齐到任何会话/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('overview-subscription-plans-card')
    ).not.toBeInTheDocument();
  });

  it('aligns usage trend row and renders subscription plans card with Astryx ProgressBar when active plans exist', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 1,
      total_tokens: sourced(250),
      estimated_cost: 0.25,
      sessions: [],
      daily_usage: [
        {
          date: '2026-09-02',
          sessions: 1,
          tokens: sourced(250),
          cost: 0.25,
          models_used: ['claude-sonnet-4'],
        },
      ],
      weekly_comparison: {
        current_week: { sessions: 1, cost: 0.25, tokens: 250 },
        last_week: { sessions: 0, cost: null, tokens: null },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      by_model: [],
      by_folder: [],
      by_agent: [],
      provider_status: [],
      unattributed_vendor_sessions: 0,
      last_updated: Date.now(),
      pricing_notice: null,
    });

    vi.mocked(agentManagementApi.planUsage).mockImplementation(
      async (agentId: string) => {
        if (agentId === 'claude_code') {
          return {
            type: 'OK',
            usage: {
              agentId: 'claude_code',
              planType: 'max',
              windows: [
                {
                  id: 'five_hour',
                  usedPercent: 35,
                  windowMinutes: 300,
                  resetsAtMs: Date.now() + 3_600_000,
                },
                {
                  id: 'seven_day',
                  usedPercent: 72,
                  windowMinutes: 10_080,
                  resetsAtMs: Date.now() + 86_400_000,
                },
                {
                  id: 'monthly',
                  usedPercent: 92,
                  windowMinutes: 43_200,
                  resetsAtMs: Date.now() + 172_800_000,
                },
              ],
              credits: null,
              fetchedAtMs: Date.now(),
            },
          } as never;
        }
        return {
          type: 'UNAVAILABLE',
          reason: 'NOT_LOGGED_IN',
        } as never;
      }
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    const trendCard = (
      await screen.findByRole('heading', { name: '用量趋势' })
    ).closest('section') as HTMLElement;
    expect(trendCard).toHaveClass('kanban-usage-trend-row__trend');
    expect(trendCard.parentElement).toHaveClass('kanban-usage-trend-row');

    const plansCard = await screen.findByTestId(
      'overview-subscription-plans-card'
    );
    expect(plansCard).toBeVisible();
    expect(
      within(plansCard).getByRole('heading', { name: '订阅套餐' })
    ).toBeVisible();
    expect(trendCard.parentElement?.nextElementSibling).toBe(plansCard);

    const claudeRow = within(plansCard).getByTestId(
      'subscription-plan-row-claude_code'
    );
    expect(
      within(claudeRow).getAllByText('Claude Code').length
    ).toBeGreaterThanOrEqual(2);

    const windowsGrid = within(claudeRow).getByTestId(
      'subscription-plan-windows-claude_code'
    );
    expect(windowsGrid).toHaveStyle({
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    });

    expect(within(windowsGrid).getByText('5 小时窗口')).toBeVisible();
    expect(within(windowsGrid).getByText('每周窗口（全部模型）')).toBeVisible();
    expect(within(windowsGrid).getByText('每月窗口')).toBeVisible();

    const progressBars = within(windowsGrid).getAllByRole('progressbar');
    expect(progressBars).toHaveLength(3);
    expect(progressBars[0]).toHaveAttribute('aria-valuenow', '35');
    expect(progressBars[1]).toHaveAttribute('aria-valuenow', '72');
    expect(progressBars[2]).toHaveAttribute('aria-valuenow', '92');
  });
});
