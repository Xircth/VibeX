import { describe, expect, it } from 'vitest';

import type { RouterProvision } from './account';
import {
  ROUTER_PROVIDER_NAME,
  openCodeConnectRequest,
  providerSaveRequest,
  supportsModelRouter,
} from './preset';

function provision(overrides: Partial<RouterProvision>): RouterProvision {
  return {
    apiKey: 'vxr-test',
    agentId: 'claude_code',
    protocol: 'anthropic',
    baseUrl: 'https://site.test/api/router',
    model: { id: 'sonnet', name: 'Sonnet' },
    models: [
      { id: 'opus', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet' },
    ],
    ...overrides,
  };
}

describe('providerSaveRequest', () => {
  it('writes a bare model id for agents with a single-model preset', () => {
    expect(providerSaveRequest(provision({}), null)).toEqual({
      id: null,
      name: ROUTER_PROVIDER_NAME,
      agent_id: 'claude_code',
      api_url: 'https://site.test/api/router',
      api_key: 'vxr-test',
      model: 'sonnet',
    });
  });

  it('updates the existing preset instead of creating another', () => {
    expect(providerSaveRequest(provision({}), 'preset-1').id).toBe('preset-1');
  });

  it('names the wire protocol in the Pi spec and lists the chosen model first', () => {
    const anthropic = providerSaveRequest(provision({ agentId: 'pi' }), null);
    expect(JSON.parse(anthropic.model)).toEqual({
      id: 'sonnet',
      api: 'anthropic-messages',
      models: ['sonnet', 'opus'],
    });
    const openai = providerSaveRequest(
      provision({ agentId: 'pi', protocol: 'openai' }),
      null
    );
    expect(JSON.parse(openai.model).api).toBe('openai-completions');
  });

  it('writes every reachable model into the Grok spec', () => {
    const request = providerSaveRequest(
      provision({ agentId: 'grok', protocol: 'openai' }),
      null
    );
    expect(JSON.parse(request.model)).toEqual({
      id: 'sonnet',
      api_backend: 'responses',
      context_window: null,
      models: ['sonnet', 'opus'],
    });
  });
});

describe('openCodeConnectRequest', () => {
  it('points the Anthropic package at the versioned root', () => {
    const request = openCodeConnectRequest(provision({ agentId: 'opencode' }));
    expect(request.npm).toBe('@ai-sdk/anthropic');
    expect(request.base_url).toBe('https://site.test/api/router/v1');
    expect(request.models.map((model) => model.id)).toEqual(['sonnet', 'opus']);
  });

  it('keeps the OpenAI-compatible base as issued', () => {
    const request = openCodeConnectRequest(
      provision({
        agentId: 'opencode',
        protocol: 'openai',
        baseUrl: 'https://site.test/api/router/v1',
      })
    );
    expect(request.npm).toBe('@ai-sdk/openai-compatible');
    expect(request.base_url).toBe('https://site.test/api/router/v1');
    expect(request.enabled).toBe(true);
  });

  it('allows saving an OpenCode provider preset without enabling it immediately', () => {
    const request = openCodeConnectRequest(
      provision({ agentId: 'opencode' }),
      false
    );
    expect(request.enabled).toBe(false);
  });
});

describe('supportsModelRouter', () => {
  it('offers the entry only where a preset can be written', () => {
    expect(supportsModelRouter('codex')).toBe(true);
    expect(supportsModelRouter('deepseek_harness')).toBe(false);
    expect(supportsModelRouter('antigravity')).toBe(false);
  });
});
