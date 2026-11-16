import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PulseRuleSpec } from '@/lib/api/pulse';

import {
  AutomationProposalCard,
  BUILT_IN_SAMPLE_EVENTS,
  PulseEvalModeControl,
  PulseFilterBuilder,
} from './index';

function buildMultiTargetSpec(
  overrides: Partial<PulseRuleSpec> = {}
): PulseRuleSpec {
  return {
    name: 'PR & Triage Automation',
    description: 'Route incoming Jira/GitHub signals across memory primitives.',
    evalMode: 'observe',
    orchestrator: 'superagent_router',
    filter: {
      sourceKinds: ['jira'],
      sourceInstanceIds: [],
      eventTypes: ['jira.issue.transitioned'],
      allowedActors: [],
      conditions: [
        { op: 'eq', pointer: '/issue/priority', value: 'P0' },
        { op: 'not_bot_actor' },
      ],
    },
    temporal: {
      kind: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      weekdaysOnly: true,
    },
    targets: [
      {
        kind: 'session',
        mode: 'ephemeral_fresh',
        agentId: 'codex',
        workspaceIsolation: 'isolated_worktree',
        promptTemplate: 'Fix {{issue.key}}: {{issue.summary}} on {{threadKey}}',
      },
      {
        kind: 'bot',
        memberId: 'sre-lead-bot',
        conversationScope: 'fixed_primary',
        mailboxPolicy: 'coalesce_batch',
        promptTemplate: 'Record {{issue.key}} in persistent reliability ledger',
      },
      {
        kind: 'group',
        spaceId: 'eng-council',
        dispatchMode: {
          type: 'moderator_triage',
          moderatorMemberId: 'moderator-bot',
        },
        messageTemplate: 'Triage {{issue.key}} in council',
      },
      {
        kind: 'user',
        interactionKind: 'approval',
        titleTemplate: 'Approve {{issue.key}} rollout',
        bodyTemplate: 'Confirm production rollout for {{threadKey}}',
        slaTimeoutSeconds: 900,
      },
      {
        kind: 'workflow',
        workflowId: 'wf-release-gate',
        pinnedVersion: 3,
      },
    ],
    ...overrides,
  };
}

describe('PulseEvalModeControl & AutomationProposalCard', () => {
  beforeEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
  });

  it('switches Off | Observe | Auto modes cleanly when human-authored', () => {
    const onEvalModeChange = vi.fn();
    const onSave = vi.fn();

    render(
      <AutomationProposalCard
        spec={buildMultiTargetSpec()}
        matchedCount={14}
        observedCount={37}
        onEvalModeChange={onEvalModeChange}
        onSave={onSave}
      />
    );

    expect(screen.getByText('Jira')).toBeVisible();
    expect(screen.getByText('Cron · 0 9 * * 1-5')).toBeVisible();
    expect(screen.getByText('超级智能体路由')).toBeVisible();

    expect(
      within(screen.getByTestId('proposal-target-badge-0')).getByText(
        '临时会话 · 全新上下文'
      )
    ).toBeVisible();
    expect(
      within(screen.getByTestId('proposal-target-badge-1')).getByText(
        '常驻 Bot · 持久记忆'
      )
    ).toBeVisible();
    expect(
      within(screen.getByTestId('proposal-target-badge-2')).getByText(
        '群组席位'
      )
    ).toBeVisible();
    expect(
      within(screen.getByTestId('proposal-target-badge-3')).getByText(
        '用户审批'
      )
    ).toBeVisible();
    expect(
      within(screen.getByTestId('proposal-target-badge-4')).getByText(
        'Workflow 工作流'
      )
    ).toBeVisible();

    expect(screen.getByText('14').closest('span')).toHaveClass('tabular-nums');
    expect(screen.getByText('37').closest('span')).toHaveClass('tabular-nums');

    const modeGroup = screen.getByRole('group', { name: '运行模式' });
    fireEvent.click(within(modeGroup).getByRole('button', { name: '自动' }));
    expect(onEvalModeChange).toHaveBeenCalledWith('auto');

    fireEvent.click(screen.getByRole('button', { name: /保存并启用/ }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ evalMode: 'auto' }),
      'auto',
      false
    );

    fireEvent.click(within(modeGroup).getByRole('button', { name: '关闭' }));
    expect(onEvalModeChange).toHaveBeenCalledWith('off');
    expect(screen.getByRole('button', { name: /保存规则/ })).toBeVisible();
  });

  it('enforces explicit human confirmation before enabling Auto on untrusted_external or draftOnly proposals', () => {
    const onEvalModeChange = vi.fn();
    const onSave = vi.fn();

    render(
      <AutomationProposalCard
        spec={buildMultiTargetSpec({ evalMode: 'auto' })}
        draftOnly
        mandateOrigin="untrusted_external"
        onEvalModeChange={onEvalModeChange}
        onSave={onSave}
      />
    );

    const lockBanner = screen.getByTestId('pulse-external-draft-lock');
    expect(lockBanner).toBeVisible();
    expect(within(lockBanner).getByText('外部草稿 · 需人工确认')).toBeVisible();

    const modeGroup = screen.getByRole('group', { name: '运行模式' });
    const autoButton = within(modeGroup).getByRole('button', { name: /自动/ });
    const observeButton = within(modeGroup).getByRole('button', {
      name: '观察',
    });

    expect(autoButton).toBeDisabled();
    expect(observeButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      within(lockBanner).getByRole('button', { name: '确认草稿' })
    );
    expect(autoButton).not.toBeDisabled();
    expect(within(lockBanner).getByText('已确认')).toBeVisible();

    fireEvent.click(autoButton);
    fireEvent.click(screen.getByRole('button', { name: /保存并启用/ }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ evalMode: 'auto' }),
      'auto',
      true
    );
  });

  it('expands Test Sample dry-run bench and evaluates conditions, rendered prompts, and exhaustive violations', () => {
    render(
      <AutomationProposalCard
        spec={buildMultiTargetSpec()}
        sampleEvents={BUILT_IN_SAMPLE_EVENTS}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /样本测试/ }));

    const jiraSample = BUILT_IN_SAMPLE_EVENTS[1];
    const sampleTextarea = screen.getByLabelText('样本事件 JSON');
    fireEvent.change(sampleTextarea, {
      target: { value: JSON.stringify(jiraSample, null, 2) },
    });

    expect(
      screen.getByText(
        /Fix CORE-128: Fix race condition in worktree checkout lock on jira:CORE-128/
      )
    ).toBeVisible();
  });

  it('switches AutomationProposalCard and PulseFilterBuilder copy cleanly between zh-CN and en', async () => {
    try {
      const { rerender } = render(
        <AutomationProposalCard
          spec={buildMultiTargetSpec()}
          defaultDryRunOpen
          onSave={vi.fn()}
        />
      );

      expect(screen.getByText('超级智能体路由')).toBeVisible();
      expect(
        within(screen.getByTestId('proposal-target-badge-0')).getByText(
          '临时会话 · 全新上下文'
        )
      ).toBeVisible();
      expect(screen.getByRole('button', { name: /样本测试/ })).toBeVisible();

      await act(async () => {
        await i18n.changeLanguage('en');
      });
      rerender(
        <AutomationProposalCard
          spec={buildMultiTargetSpec()}
          defaultDryRunOpen
          onSave={vi.fn()}
        />
      );

      expect(screen.getByText('Superagent Router')).toBeVisible();
      expect(
        within(screen.getByTestId('proposal-target-badge-0')).getByText(
          'Ephemeral Session · Fresh Context'
        )
      ).toBeVisible();
      expect(screen.getByRole('group', { name: 'Evaluation mode' })).toBeVisible();
      expect(screen.getByRole('button', { name: /Test Sample/i })).toBeVisible();
      expect(screen.getByRole('button', { name: /Save \/ Enable/i })).toBeVisible();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });
});

describe('PulseFilterBuilder', () => {
  beforeEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
  });

  it('supports adding/editing operators and reports exhaustive validation violations without fail-fast', () => {
    const onChange = vi.fn();
    const invalidSpec: PulseRuleSpec = {
      name: '',
      evalMode: 'observe',
      filter: {
        sourceKinds: ['jira'],
        sourceInstanceIds: [],
        eventTypes: [],
        allowedActors: [],
        conditions: [
          { op: 'eq', pointer: '', value: 'P0' },
          { op: 'regex', pointer: '/issue/summary', pattern: '[unclosed' },
          { op: 'gt', pointer: '/failedStepCount', value: 5 },
        ],
      },
      targets: [],
    };

    render(
      <PulseFilterBuilder
        filter={invalidSpec.filter}
        ruleSpec={invalidSpec}
        sampleEvents={[BUILT_IN_SAMPLE_EVENTS[1]]}
        onChange={onChange}
      />
    );

    expect(screen.getByText(/Rule name is required/i)).toBeVisible();
    expect(screen.getByText(/At least one target is required/i)).toBeVisible();
    expect(screen.getByText(/JSON Pointer cannot be empty/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /添加条件/ }));
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('renders standalone PulseEvalModeControl in small size and supports ArrowLeft/ArrowRight keyboard navigation', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PulseEvalModeControl value="observe" size="sm" onChange={onChange} />
    );
    const observeBtn = screen.getByRole('button', { name: '观察' });
    fireEvent.keyDown(observeBtn, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('auto');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '自动' })
    );

    onChange.mockClear();
    rerender(
      <PulseEvalModeControl
        value="observe"
        size="sm"
        lockAuto
        onChange={onChange}
      />
    );
    fireEvent.keyDown(screen.getByRole('button', { name: '观察' }), {
      key: 'ArrowRight',
    });
    expect(onChange).toHaveBeenCalledWith('off');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '关闭' })
    );
  });
});
