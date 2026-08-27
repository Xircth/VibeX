import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { OpenCodeSubscriptionPanel } from './OpenCodeSubscriptionPanel';

describe('OpenCodeSubscriptionPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connects Zen and Go without a models.dev catalog', async () => {
    vi.spyOn(agentManagementApi, 'openCodeProviders').mockResolvedValue({
      providers: [],
    });
    const connect = vi
      .spyOn(agentManagementApi, 'connectOpenCodeProvider')
      .mockResolvedValue({
        providers: [
          {
            provider_id: 'opencode',
            name: 'OpenCode Zen',
            npm: null,
            api: null,
            base_url: null,
            models: [],
            credential_present: true,
            enabled: true,
          },
        ],
      });
    const user = userEvent.setup();
    render(<OpenCodeSubscriptionPanel />);

    expect(await screen.findByText('Zen')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
    expect(screen.queryByText('models.dev 目录')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Provider ID')).not.toBeInTheDocument();

    await user.type(
      screen.getAllByPlaceholderText('输入 API Key')[0],
      'zen-key'
    );
    await user.click(screen.getAllByRole('button', { name: '连接' })[0]);
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          provider_id: 'opencode',
          api_key: 'zen-key',
        })
      )
    );
  });
});
