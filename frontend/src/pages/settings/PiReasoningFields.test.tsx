import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { reasoningFromModel } from '@/lib/piThinking';

import { PiReasoningFields } from './PiReasoningFields';

describe('PiReasoningFields', () => {
  it('puts the declare-reasoning checkbox before its label', () => {
    const { container } = render(
      <PiReasoningFields
        disabled={false}
        reasoning={reasoningFromModel(false, undefined)}
        thinkingLevel=""
        onReasoningChange={vi.fn()}
        onThinkingLevelChange={vi.fn()}
      />
    );
    const enable = container.querySelector('.pi-reasoning-enable');
    expect(enable?.firstElementChild).toHaveAttribute('type', 'checkbox');
    expect(enable).toHaveTextContent('声明推理能力');
    expect(
      screen.queryByRole('button', { name: 'minimal' })
    ).not.toBeInTheDocument();
  });

  it('lists every thinking level with a leading checkbox and skips xhigh by default', async () => {
    const onReasoningChange = vi.fn();
    render(
      <PiReasoningFields
        disabled={false}
        reasoning={reasoningFromModel(true, undefined)}
        thinkingLevel="off"
        onReasoningChange={onReasoningChange}
        onThinkingLevelChange={vi.fn()}
      />
    );
    expect(screen.getByText('供应商 effort 值')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'off' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'high' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'xhigh' })).not.toBeChecked();
    expect(
      screen.queryByRole('button', { name: 'xhigh', pressed: false })
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'xhigh' }));
    expect(onReasoningChange).toHaveBeenCalled();
    const next = onReasoningChange.mock.calls[0][0];
    expect(next.levels).toContain('xhigh');
  });
});
