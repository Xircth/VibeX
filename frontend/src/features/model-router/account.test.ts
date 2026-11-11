import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountError, accountApi, accountToken } from './account';

const login = {
  requestId: 'req',
  verifier: 'ver',
  userCode: 'ABCD-1234',
  verifyUrl: 'https://site.test/desktop/authorize?request=req',
  expiresIn: 600,
  interval: 2,
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe('accountApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the token once the browser approves the device', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'pending' }));
    await expect(accountApi.pollLogin(login)).resolves.toBe(false);
    expect(accountToken()).toBeNull();

    fetchMock.mockResolvedValueOnce(
      respond(200, { status: 'approved', token: 'tok' })
    );
    await expect(accountApi.pollLogin(login)).resolves.toBe(true);
    expect(accountToken()).toBe('tok');
  });

  it('reports a refused or expired request by its status', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'expired' }));
    await expect(accountApi.pollLogin(login)).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('sends the token as a Bearer header and drops it when rejected', async () => {
    window.localStorage.setItem('vibex.account.token', 'tok');
    fetchMock.mockResolvedValueOnce(respond(401, { error: 'unauthorized' }));
    await expect(accountApi.overview()).rejects.toMatchObject({
      code: 'signed_out',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(accountToken()).toBeNull();
  });

  it('does not call the site when signed out', async () => {
    await expect(accountApi.overview()).rejects.toBeInstanceOf(AccountError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forgets the token on sign-out even if the revoke fails', async () => {
    window.localStorage.setItem('vibex.account.token', 'tok');
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await accountApi.signOut();
    expect(accountToken()).toBeNull();
  });
});
