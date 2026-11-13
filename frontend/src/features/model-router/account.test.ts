import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_TOKEN_STORAGE_KEY,
  accountApi,
  modelMarketplacePath,
  openModelMarketplace,
} from './account';

const openExternal = vi.hoisted(() => vi.fn());

vi.mock('./openExternal', () => ({ openExternal }));

describe('accountApi & Model Marketplace helpers', () => {
  it('keeps the deadline active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) =>
          ({
            status: 200,
            ok: true,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                );
              }),
          }) as Response
      );
      const result = accountApi.startLogin();
      const assertion = expect(result).rejects.toMatchObject({
        code: 'network',
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not store an approved token after the login was canceled', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      return new Response(
        JSON.stringify({ status: 'approved', token: 'late-token' }),
        { status: 200 }
      );
    });
    expect(
      await accountApi.pollLogin(
        {
          requestId: 'request',
          verifier: 'secret',
          userCode: '',
          verifyUrl: '',
          expiresIn: 60,
          interval: 1,
        },
        controller.signal
      )
    ).toBe(false);
    expect(localStorage.getItem(ACCOUNT_TOKEN_STORAGE_KEY)).toBeNull();
  });
  beforeEach(() => {
    localStorage.clear();
    openExternal.mockReset();
    vi.restoreAllMocks();
  });

  it('passes nextPath (/account by default or custom target) when starting desktop login', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            requestId: 'req-1',
            verifier: 'ver-1',
            userCode: 'ABCD-1234',
            verifyUrl: 'https://vibex.test/desktop/authorize?request=req-1',
            expiresIn: 600,
            interval: 2,
          }),
          { status: 200 }
        )
    );

    await accountApi.startLogin();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      deviceName: 'VibeX Desktop',
      hostId: '',
      nextPath: '/account',
    });

    await accountApi.startLogin(modelMarketplacePath('claude_code'));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      deviceName: 'VibeX Desktop',
      hostId: '',
      nextPath: '/account/models?agent=claude_code',
    });
  });

  it('uses web-handoff when signed in and falls back to direct URL on failure', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'tok_123');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          handoffUrl:
            'https://vibex.test/api/auth/desktop/web-handoff?ticket=h_1',
          expiresIn: 60,
        }),
        { status: 200 }
      )
    );

    const url = await openModelMarketplace('codex');
    expect(url).toBe(
      'https://vibex.test/api/auth/desktop/web-handoff?ticket=h_1'
    );
    expect(openExternal).toHaveBeenCalledWith(
      'https://vibex.test/api/auth/desktop/web-handoff?ticket=h_1'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      targetPath: '/account/models?agent=codex',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'failed' }), { status: 500 })
    );
    const fallback = await openModelMarketplace('codex');
    expect(fallback).toContain('/account/models?agent=codex');
    expect(openExternal).toHaveBeenLastCalledWith(fallback);
  });

  it('redeems a desktop import ticket without clearing stored token on 401 and retries without token', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'stale_tok');
    const provision = {
      apiKey: 'sk-vxr-1',
      agentId: 'claude_code',
      protocol: 'anthropic' as const,
      baseUrl: 'https://vibex.test/api/router',
      model: { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    };

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(provision), { status: 200 })
      );

    const result = await accountApi.redeemImportTicket('tkt_999');
    expect(result).toEqual(provision);
    expect(localStorage.getItem(ACCOUNT_TOKEN_STORAGE_KEY)).toBe('stale_tok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
