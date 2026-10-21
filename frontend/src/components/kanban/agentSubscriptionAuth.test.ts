import { describe, expect, it } from 'vitest';
import { isSignedInSubscription } from './agentSubscriptionAuth';

const grok = {
  enabled: true,
  authentication: 'account' as const,
  agent_id: 'grok',
};

describe('isSignedInSubscription', () => {
  it('accepts a signed-in subscription mode for a plan-capable agent', () => {
    expect(isSignedInSubscription(grok, { mode: 'subscription' })).toBe(true);
  });

  it('rejects API-key login even when the agent account exists', () => {
    expect(isSignedInSubscription(grok, { mode: 'official_api' })).toBe(false);
  });

  it('rejects an agent that cannot report plan quota', () => {
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'qoder' },
        { mode: 'official_subscription' }
      )
    ).toBe(false);
  });

  it('accepts an Antigravity Google login and ignores an API key', () => {
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'antigravity' },
        { mode: 'oauth-personal' }
      )
    ).toBe(true);
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'antigravity' },
        { mode: 'oauth-business' }
      )
    ).toBe(true);
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'antigravity' },
        { mode: 'gemini-api-key' }
      )
    ).toBe(false);
  });

  it('accepts OpenCode Go and Kimi official subscriptions', () => {
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'opencode' },
        { mode: 'official_subscription' }
      )
    ).toBe(true);
    expect(
      isSignedInSubscription(
        { ...grok, agent_id: 'kimi_code' },
        { mode: 'official_subscription' }
      )
    ).toBe(true);
  });
});
