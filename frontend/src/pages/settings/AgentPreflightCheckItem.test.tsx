import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPreflightItemView } from 'shared/types';

import '@/i18n';

import {
  AgentPreflightCard,
  AgentPreflightCheckItem,
} from './AgentPreflightCheckItem';

const item: AgentPreflightItemView = {
  id: 'acp',
  label: 'ACP 适配器',
  status: 'pass',
  detail: '',
  version: '0.64.1',
  path: '/usr/local/bin/pi-acp',
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

  it('renders unified runtime entry label for both ACP and nativeEngine items', () => {
    const { rerender } = render(<AgentPreflightCard item={item} />);
    expect(screen.getByText('运行入口')).toBeInTheDocument();
    expect(screen.queryByText('ACP 适配器')).not.toBeInTheDocument();

    rerender(
      <AgentPreflightCard
        item={{ ...item, id: 'native_runtime', label: '原生引擎运行时' }}
        nativeEngine
      />
    );
    expect(screen.getByText('运行入口')).toBeInTheDocument();
    expect(screen.queryByText('原生引擎运行时')).not.toBeInTheDocument();
  });
});
