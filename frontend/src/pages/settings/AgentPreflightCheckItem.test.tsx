import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPreflightItemView } from 'shared/types';

import '@/i18n';

import { AgentPreflightCheckItem } from './AgentPreflightCheckItem';

const item: AgentPreflightItemView = {
  id: 'acp',
  label: 'ACP 适配器',
  status: 'pass',
  detail: '',
  version: '0.64.1',
  path: '/usr/local/bin/claude-agent-acp',
  source: null,
  repairable: true,
  update_available: true,
  available_version: '0.70.0',
  update_group: null,
};

describe('AgentPreflightCheckItem', () => {
  it('starts an update from the available status and has no separate update button', async () => {
    const onUpdate = vi.fn();
    render(
      <AgentPreflightCheckItem
        detail=""
        item={item}
        label="ACP 适配器"
        onUpdate={onUpdate}
      />
    );

    expect(
      screen.queryByRole('button', { name: '更新' })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '可更新' }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
