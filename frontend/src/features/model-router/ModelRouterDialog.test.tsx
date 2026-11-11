import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelRouterDialog } from './ModelRouterDialog';

const api = vi.hoisted(() => ({
  token: null as string | null,
  startLogin: vi.fn(),
  pollLogin: vi.fn(),
  signOut: vi.fn(),
  overview: vi.fn(),
  provision: vi.fn(),
}));
const openExternal = vi.hoisted(() => vi.fn());

vi.mock('./account', async (original) => ({
  ...(await original<typeof import('./account')>()),
  accountToken: () => api.token,
  accountApi: api,
}));
vi.mock('./openExternal', () => ({ openExternal }));

const overview = {
  user: { email: 'me@example.com', username: 'me', displayName: 'Me' },
  balanceMicro: 12_500_000,
  tasks: [{ id: 'task-1', orderNo: 'VX1', agentId: 'pi', modelId: 'sonnet' }],
  agents: [{ id: 'pi', name: 'Pi', native: [], others: ['opus', 'sonnet'] }],
  models: [
    {
      id: 'opus',
      name: 'Opus',
      vendor: 'anthropic',
      inputMicro: 15_000_000,
      outputMicro: 75_000_000,
      discountPermille: 500,
    },
    {
      id: 'sonnet',
      name: 'Sonnet',
      vendor: 'anthropic',
      inputMicro: 3_000_000,
      outputMicro: 15_000_000,
      discountPermille: 1000,
    },
  ],
};

function renderDialog(onApply = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  render(
    <HotkeysProvider>
      <ModelRouterDialog
        agentId="pi"
        open
        onOpenChange={onOpenChange}
        onApply={onApply}
      />
    </HotkeysProvider>
  );
  return { onApply, onOpenChange };
}

describe('ModelRouterDialog', () => {
  beforeEach(() => {
    api.token = null;
    for (const mock of [
      api.startLogin,
      api.pollLogin,
      api.signOut,
      api.overview,
      api.provision,
      openExternal,
    ]) {
      mock.mockReset();
    }
  });

  it('opens the browser and waits for sign-in completion', async () => {
    api.startLogin.mockResolvedValue({
      requestId: 'req',
      verifier: 'ver',
      userCode: 'ABCD-1234',
      verifyUrl: 'https://site.test/desktop/authorize?request=req',
      expiresIn: 600,
      interval: 2,
    });
    renderDialog();

    await userEvent.click(
      await screen.findByRole('button', { name: '登录 VibeX 账号' })
    );

    expect(
      await screen.findByText('请在打开的浏览器页面中完成登录。')
    ).toBeInTheDocument();
    expect(openExternal).toHaveBeenCalledWith(
      'https://site.test/desktop/authorize?request=req'
    );
  });

  it('preselects the purchased model and applies it with its task', async () => {
    api.token = 'tok';
    api.overview.mockResolvedValue(overview);
    const provision = {
      apiKey: 'vxr-test',
      agentId: 'pi',
      protocol: 'anthropic',
      baseUrl: 'https://site.test/api/router',
      model: { id: 'sonnet', name: 'Sonnet' },
      models: [{ id: 'sonnet', name: 'Sonnet' }],
    };
    api.provision.mockResolvedValue(provision);
    const { onApply, onOpenChange } = renderDialog();

    expect(await screen.findByText('余额 12.50')).toBeInTheDocument();
    expect(screen.getByText('5 折')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Sonnet/ })).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: '接入' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith(provision));
    expect(api.provision).toHaveBeenCalledWith('pi', 'sonnet', 'task-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and shows why when applying fails', async () => {
    api.token = 'tok';
    api.overview.mockResolvedValue(overview);
    api.provision.mockResolvedValue({
      model: { id: 'sonnet', name: 'Sonnet' },
    });
    const { onOpenChange } = renderDialog(
      vi.fn().mockRejectedValue(new Error('config is read-only'))
    );

    await userEvent.click(await screen.findByRole('button', { name: '接入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'config is read-only'
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
