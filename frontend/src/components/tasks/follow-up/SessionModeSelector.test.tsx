import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSessionMode } from 'shared/types';
import { SessionModeSelector } from './SessionModeSelector';

const MODES: AgentSessionMode[] = [
  { id: 'plan', label: 'Plan', description: 'Read-only planning' },
  { id: 'code', label: 'Code' },
];

describe('SessionModeSelector', () => {
  it('renders nothing when the agent advertises no modes', () => {
    const { container } = render(
      <SessionModeSelector
        modes={[]}
        current={null}
        selected={null}
        onSelect={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current mode label when there is no pending selection', () => {
    render(
      <SessionModeSelector
        modes={MODES}
        current="plan"
        selected={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTitle('会话模式')).toHaveTextContent('Plan');
  });

  it('prefers the pending selection over the agent current mode', () => {
    render(
      <SessionModeSelector
        modes={MODES}
        current="plan"
        selected="code"
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTitle('会话模式')).toHaveTextContent('Code');
  });

  it('reports the chosen mode id', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SessionModeSelector
        modes={MODES}
        current="plan"
        selected={null}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByTitle('会话模式'));
    await user.click(await screen.findByText('Code'));

    expect(onSelect).toHaveBeenCalledWith('code');
  });
});
