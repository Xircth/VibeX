import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentStatusMenu } from './AgentStatusMenu';

function agent(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id' | 'display_name'>
): AgentManagementView {
  return {
    description: '',
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
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

const agents = [
  agent({
    agent_id: 'claude_code',
    display_name: 'Claude Code',
    position: 0,
  }),
  agent({
    agent_id: 'codex',
    display_name: 'Codex',
    position: 1,
  }),
  agent({
    agent_id: 'opencode',
    display_name: 'OpenCode',
    enabled: false,
    position: 2,
  }),
];

describe('AgentStatusMenu', () => {
  it('shows only the default Agent until hover reveals every enabled Agent', () => {
    render(<AgentStatusMenu agents={agents} defaultAgentId="codex" />);

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪/,
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list');
    expect(
      within(list).getByText('Claude Code', { selector: 'span' })
    ).toBeInTheDocument();
    expect(
      within(list).getByText('Codex', { selector: 'span' })
    ).toBeInTheDocument();
    expect(within(list).queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('omits uninstalled Agents from the enabled status list', () => {
    render(
      <AgentStatusMenu
        agents={[
          ...agents,
          agent({
            agent_id: 'pi',
            display_name: 'Pi',
            lifecycle: 'uninstalled',
            position: 3,
          }),
          agent({
            agent_id: 'cursor',
            display_name: 'Cursor',
            lifecycle: 'needs_auth',
            position: 4,
          }),
        ]}
        defaultAgentId="codex"
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', {
        name: /默认 Agent：Codex，已就绪/,
      })
    );

    const list = screen.getByRole('list');
    expect(
      within(list).getByText('Claude Code', { selector: 'span' })
    ).toBeInTheDocument();
    expect(
      within(list).getByText('Cursor', { selector: 'span' })
    ).toBeInTheDocument();
    expect(within(list).queryByText('Pi')).not.toBeInTheDocument();
    expect(within(list).queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('also expands for keyboard focus', () => {
    render(<AgentStatusMenu agents={agents} defaultAgentId="codex" />);

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪/,
    });
    fireEvent.focus(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('shows an update cue and opens the matching Agent settings page', () => {
    const onOpenAgentSettings = vi.fn();
    render(
      <AgentStatusMenu
        agents={agents}
        defaultAgentId="codex"
        updatableAgentIds={new Set(['claude_code'])}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    );

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪，有更新/,
    });
    expect(within(trigger).getByText('有更新')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '可更新' })).toBeNull();

    fireEvent.mouseEnter(trigger);

    const claudeRow = screen.getByRole('listitem', { name: /Claude Code/ });
    const updateButton = within(claudeRow).getByRole('button', {
      name: '可更新',
    });
    expect(
      within(screen.getByRole('listitem', { name: /Codex/ })).queryByRole(
        'button',
        { name: '可更新' }
      )
    ).toBeNull();

    fireEvent.click(updateButton);
    expect(onOpenAgentSettings).toHaveBeenCalledWith('claude_code');
  });

  it('merges connector and auth into the onboarding status badge and opens settings on click', () => {
    const onOpenAgentSettings = vi.fn();
    render(
      <AgentStatusMenu
        agents={[
          agent({
            agent_id: 'grok',
            display_name: 'Grok',
            acp_version: '1.0.0',
            authentication: 'account',
            lifecycle: 'ready',
            position: 0,
          }),
          agent({
            agent_id: 'cursor',
            display_name: 'Cursor',
            acp_version: '1.0.0',
            authentication: 'not_logged_in',
            lifecycle: 'needs_auth',
            position: 1,
          }),
          agent({
            agent_id: 'pi',
            display_name: 'Pi',
            acp_version: null,
            authentication: 'not_logged_in',
            lifecycle: 'needs_repair',
            position: 2,
          }),
        ]}
        defaultAgentId="grok"
        onOpenAgentSettings={onOpenAgentSettings}
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /默认 Agent：Grok/ })
    );

    expect(screen.queryByText('连接器可用')).toBeNull();
    expect(screen.queryByText('已登录')).toBeNull();
    expect(screen.queryByText('未登录')).toBeNull();

    const grokRow = screen.getByRole('listitem', { name: /Grok/ });
    const readyButton = within(grokRow).getByRole('button', { name: '已就绪' });
    expect(within(readyButton).getByRole('status')).toHaveAttribute(
      'data-status',
      'ready'
    );

    const cursorRow = screen.getByRole('listitem', { name: /Cursor/ });
    expect(within(cursorRow).getByRole('status')).toHaveAttribute(
      'data-status',
      'needs_auth'
    );
    expect(within(cursorRow).getByText('待鉴权')).toBeInTheDocument();

    const piRow = screen.getByRole('listitem', { name: /Pi/ });
    expect(within(piRow).getByRole('status')).toHaveAttribute(
      'data-status',
      'uninstalled'
    );
    expect(within(piRow).getByText('未安装')).toBeInTheDocument();

    fireEvent.click(readyButton);
    expect(onOpenAgentSettings).toHaveBeenCalledWith('grok');
  });

  it('places default beside Agent name, update chip before status badge, and aligns columns', () => {
    render(
      <AgentStatusMenu
        agents={[
          agent({
            agent_id: 'claude_code',
            display_name: 'Claude Code',
            acp_version: '1.0.0',
          }),
          agent({
            agent_id: 'codex',
            display_name: 'Codex',
            acp_version: '1.0.0',
          }),
        ]}
        defaultAgentId="claude_code"
        updatableAgentIds={new Set(['claude_code', 'codex'])}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /默认 Agent：Claude Code/ })
    );

    const list = screen.getByRole('list');
    expect(list.className).toMatch(/grid/);
    const claude = screen.getByRole('listitem', { name: /Claude Code/ });
    const codex = screen.getByRole('listitem', { name: /Codex/ });
    expect(claude.className).toMatch(/subgrid/);
    expect(codex.className).toMatch(/subgrid/);
    expect(claude.children).toHaveLength(4);
    expect(codex.children).toHaveLength(4);

    // Column 2: Agent name + "默认" badge right next to it
    expect(claude.children[1]).toHaveTextContent('Claude Code');
    expect(
      within(claude.children[1] as HTMLElement).getByText('默认')
    ).toBeInTheDocument();
    expect(codex.children[1]).toHaveTextContent('Codex');
    expect(
      within(codex.children[1] as HTMLElement).queryByText('默认')
    ).toBeNull();

    // Column 3: Preflight-style "可更新" component to the left of the status badge
    expect(claude.children[2]).toHaveTextContent('可更新');
    expect(claude.children[2].querySelector('svg')).not.toBeNull();
    expect(codex.children[2]).toHaveTextContent('可更新');
    expect(codex.children[2].querySelector('svg')).not.toBeNull();

    // Column 4: Merged status badge on the far right
    expect(claude.children[3]).toHaveTextContent('已就绪');
    expect(codex.children[3]).toHaveTextContent('已就绪');
  });

  it('shows the ACP stepper while an install is running', () => {
    render(
      <AgentStatusMenu
        agents={[
          agent({
            agent_id: 'grok',
            display_name: 'Grok',
            lifecycle: 'installing',
            authentication: 'not_logged_in',
            acp_version: null,
          }),
        ]}
        defaultAgentId="grok"
        operations={{
          grok: {
            operationId: 'op-1',
            kind: 'install',
            status: 'running',
            progressPercent: 20,
            message: null,
            sequence: 1,
          },
        }}
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /默认 Agent：Grok/ })
    );

    expect(screen.getByLabelText('ACP 安装进度')).toBeInTheDocument();
    expect(screen.getByText('下载')).toBeInTheDocument();
    expect(screen.getByText('安装')).toBeInTheDocument();
    expect(screen.getByText('检查')).toBeInTheDocument();
  });

  it('shows the ACP stepper from lifecycle when operations are missing', () => {
    render(
      <AgentStatusMenu
        agents={[
          agent({
            agent_id: 'grok',
            display_name: 'Grok',
            lifecycle: 'installing',
            authentication: 'not_logged_in',
            acp_version: null,
          }),
        ]}
        defaultAgentId="grok"
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /默认 Agent：Grok/ })
    );

    expect(screen.getByText('下载')).toBeInTheDocument();
    expect(screen.getByText('安装')).toBeInTheDocument();
    expect(screen.getByText('检查')).toBeInTheDocument();
  });

  it('renders subscription quota on separate rows (max 2 items per row) and omits empty rows for unsubscribed Agents', () => {
    const onMenuOpen = vi.fn();
    render(
      <AgentStatusMenu
        agents={[
          agent({
            agent_id: 'claude_code',
            display_name: 'Claude Code',
            acp_version: '1.0.0',
            position: 0,
          }),
          agent({
            agent_id: 'antigravity',
            display_name: 'Antigravity',
            acp_version: '1.0.0',
            position: 1,
          }),
          agent({
            agent_id: 'codex',
            display_name: 'Codex',
            acp_version: '1.0.0',
            position: 2,
          }),
        ]}
        defaultAgentId="claude_code"
        onMenuOpen={onMenuOpen}
        planUsages={{
          claude_code: {
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
            ],
            credits: null,
          },
          antigravity: {
            planType: 'pro',
            windows: [
              {
                id: 'gemini_five_hour',
                usedPercent: 20,
                windowMinutes: 300,
                resetsAtMs: Date.now() + 3_600_000,
              },
              {
                id: 'gemini_weekly',
                usedPercent: 15,
                windowMinutes: 10_080,
                resetsAtMs: Date.now() + 86_400_000,
              },
              {
                id: 'claude_gpt_five_hour',
                usedPercent: 68,
                windowMinutes: 300,
                resetsAtMs: Date.now() + 3_600_000,
              },
              {
                id: 'claude_gpt_weekly',
                usedPercent: 92,
                windowMinutes: 10_080,
                resetsAtMs: Date.now() + 86_400_000,
              },
            ],
            credits: null,
          },
        }}
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /默认 Agent：Claude Code/ })
    );
    expect(onMenuOpen).toHaveBeenCalledTimes(1);

    const list = screen.getByRole('list');
    expect(list.className).toMatch(/gap-y-2/);

    // Claude Code: 2 quota items -> 1 bordered quota box below status row
    const claudeItem = screen.getByRole('listitem', { name: 'Claude Code' });
    expect(claudeItem.children).toHaveLength(5);
    const claudeBox = within(claudeItem).getByTestId(
      'agent-status-quota-box-claude_code'
    );
    expect(claudeBox.className).toMatch(/\bborder\b/);
    const claudeRow0 = within(claudeBox).getByTestId(
      'agent-status-quota-row-claude_code-0'
    );
    expect(claudeRow0.children).toHaveLength(2);
    expect(within(claudeRow0).getByText('5 小时窗口')).toBeInTheDocument();
    expect(within(claudeRow0).getByText('35%')).toBeInTheDocument();
    expect(
      within(claudeRow0).getByText('每周窗口（全部模型）')
    ).toBeInTheDocument();
    expect(within(claudeRow0).getByText('72%')).toBeInTheDocument();
    expect(
      within(claudeBox).queryByTestId('agent-status-quota-row-claude_code-1')
    ).toBeNull();

    // Antigravity: 4 quota items -> 2 quota rows inside 1 bordered quota box
    const antigravityItem = screen.getByRole('listitem', {
      name: 'Antigravity',
    });
    expect(antigravityItem.children).toHaveLength(5);
    const antigravityBox = within(antigravityItem).getByTestId(
      'agent-status-quota-box-antigravity'
    );
    expect(antigravityBox.className).toMatch(/\bborder\b/);
    const antigravityRow0 = within(antigravityBox).getByTestId(
      'agent-status-quota-row-antigravity-0'
    );
    const antigravityRow1 = within(antigravityBox).getByTestId(
      'agent-status-quota-row-antigravity-1'
    );
    expect(antigravityRow0.children).toHaveLength(2);
    expect(antigravityRow1.children).toHaveLength(2);
    expect(
      within(antigravityRow0).getByText('Gemini 5 小时')
    ).toBeInTheDocument();
    expect(
      within(antigravityRow0).getByText('Gemini 每周')
    ).toBeInTheDocument();
    expect(
      within(antigravityRow1).getByText('Claude/GPT 5 小时')
    ).toBeInTheDocument();
    expect(
      within(antigravityRow1).getByText('Claude/GPT 每周')
    ).toBeInTheDocument();
    expect(within(antigravityRow1).getByText('92%')).toBeInTheDocument();

    // Codex (no subscription): strictly status row only, no extra/empty rows
    const codexItem = screen.getByRole('listitem', { name: 'Codex' });
    expect(codexItem.children).toHaveLength(4);
    expect(
      within(codexItem).queryByTestId('agent-status-quota-box-codex')
    ).toBeNull();
    expect(
      within(codexItem).queryByTestId(/agent-status-quota-row-codex/)
    ).toBeNull();
  });
});
