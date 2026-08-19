import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlanEntry } from 'shared/types';
import { ConversationPlanCard } from './ConversationPlanCard';
import { toConversationPlanItem } from './conversationPlan';

const sampleEntries: PlanEntry[] = [
  { content: 'Investigate existing plan UI', status: 'completed' },
  {
    content:
      'Extract reference styles from codeg\n- Review codeg plan component',
    status: 'completed',
  },
  { content: 'Implement restyle in VibeX', status: 'in_progress' },
  { content: 'Verify in conversation stream', status: 'pending' },
];

function renderPlan(
  entries: PlanEntry[],
  expansionKey: string,
  extra?: { awaitingConfirmation?: boolean }
) {
  return (
    <ConversationPlanCard
      items={entries.map(toConversationPlanItem)}
      expansionKey={expansionKey}
      awaitingConfirmation={extra?.awaitingConfirmation}
    />
  );
}

describe('ConversationPlanCard', () => {
  it('renders nothing when there are no entries', () => {
    const { container } = render(renderPlan([], 'empty-plan'));
    expect(container.firstChild).toBeNull();
  });

  it('renders numbered steps, progress, and nested children', () => {
    render(renderPlan(sampleEntries, 'visible-plan'));

    expect(
      screen.getByRole('button', { name: '收起计划' })
    ).toBeInTheDocument();
    expect(screen.getByText('2 / 4 已完成')).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('04')).toBeInTheDocument();
    expect(
      screen.getByText('Investigate existing plan UI')
    ).toBeInTheDocument();
    expect(screen.getByText('Review codeg plan component')).toBeInTheDocument();
  });

  it('collapses to a compact Plan header', () => {
    render(renderPlan(sampleEntries, 'collapse-plan'));

    fireEvent.click(screen.getByRole('button', { name: '收起计划' }));

    expect(screen.getByRole('button', { name: '展开计划' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('2 / 4 已完成')).not.toBeInTheDocument();
    expect(document.querySelector('.conv-plan-card.is-collapsed')).toBeTruthy();
  });

  it('shows a waiting confirmation banner when the plan is gated', () => {
    render(
      renderPlan(sampleEntries, 'confirm-plan', { awaitingConfirmation: true })
    );

    expect(screen.getByRole('status')).toHaveTextContent('等待确认');
    expect(document.querySelector('.conv-plan-card.is-awaiting')).toBeTruthy();
  });
});
