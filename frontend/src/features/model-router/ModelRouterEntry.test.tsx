import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelRouterEntry } from './ModelRouterEntry';

const mocks = vi.hoisted(() => ({
  token: null as string | null,
  startLogin: vi.fn(),
  pollLogin: vi.fn(),
  openModelMarketplace: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('./account', async (original) => ({
  ...(await original<typeof import('./account')>()),
  accountToken: () => mocks.token,
  openModelMarketplace: mocks.openModelMarketplace,
  accountApi: {
    startLogin: mocks.startLogin,
    pollLogin: mocks.pollLogin,
  },
}));

vi.mock('./openExternal', () => ({
  openExternal: mocks.openExternal,
}));

describe('ModelRouterEntry', () => {
  beforeEach(() => {
    mocks.token = null;
    mocks.startLogin.mockReset();
    mocks.pollLogin.mockReset();
    mocks.openModelMarketplace.mockReset();
    mocks.openExternal.mockReset();
  });

  it('opens the web model marketplace directly when signed in without opening a local model dialog', async () => {
    mocks.token = 'tok_signed_in';
    mocks.openModelMarketplace.mockResolvedValue(
      'https://site.test/api/auth/desktop/web-handoff?ticket=1'
    );

    render(<ModelRouterEntry agentId="claude_code" />);
    await userEvent.click(
      screen.getByRole('button', { name: 'ModelRouter' })
    );

    await waitFor(() =>
      expect(mocks.openModelMarketplace).toHaveBeenCalledWith('claude_code')
    );
    expect(mocks.startLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts device login with the agent model marketplace nextPath when signed out', async () => {
    mocks.startLogin.mockResolvedValue({
      requestId: 'req-1',
      verifier: 'ver-1',
      userCode: 'WXYZ-9876',
      verifyUrl: 'https://site.test/desktop/authorize?request=req-1',
      expiresIn: 600,
      interval: 2,
    });

    render(<ModelRouterEntry agentId="codex" />);
    await userEvent.click(
      screen.getByRole('button', { name: 'ModelRouter' })
    );

    await waitFor(() =>
      expect(mocks.startLogin).toHaveBeenCalledWith(
        '/account/models?agent=codex'
      )
    );
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://site.test/desktop/authorize?request=req-1'
    );
    expect(await screen.findByText('WXYZ-9876')).toBeInTheDocument();
  });
});
