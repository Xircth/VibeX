import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAllAgentAuthKindTabs,
  peekAgentAuthKindTab,
  rememberAgentAuthKindTab,
} from './agentAuthKindTab';

describe('agentAuthKindTab', () => {
  afterEach(() => {
    clearAllAgentAuthKindTabs();
  });

  it('remembers the last selected tab per agent', () => {
    rememberAgentAuthKindTab('grok', 'provider');
    rememberAgentAuthKindTab('claude_code', 'subscription');

    expect(peekAgentAuthKindTab('grok')).toBe('provider');
    expect(peekAgentAuthKindTab('claude_code')).toBe('subscription');
  });

  it('does not leak a tab choice from one agent onto another', () => {
    rememberAgentAuthKindTab('grok', 'provider');

    expect(peekAgentAuthKindTab('claude_code')).toBeNull();
  });

  it('writes the per-agent tab map to localStorage', () => {
    rememberAgentAuthKindTab('codex', 'official_api');

    expect(JSON.parse(localStorage.getItem('vibex:agent-auth-kind-tab')!)).toEqual(
      {
        codex: 'official_api',
      }
    );
  });
});
