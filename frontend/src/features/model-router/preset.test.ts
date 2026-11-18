import { describe, expect, it } from 'vitest';

import type { RouterProvision } from './account';
import {
  MODEL_GATEWAY_ORIGIN,
  ROUTER_OPENCODE_PROVIDER_ID,
  ROUTER_PROVIDER_NAME,
  dshProviderSaveRequest,
  officialModelBaseUrl,
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

  it('names the wire protocol in the Pi and OMP spec and lists the chosen model first', () => {
    const anthropic = providerSaveRequest(provision({ agentId: 'pi' }), null);
    expect(JSON.parse(anthropic.model)).toEqual({
      id: 'sonnet',
      api: 'anthropic-messages',
      models: ['sonnet', 'opus'],
    });
    const openai = providerSaveRequest(
      provision({ agentId: 'omp', protocol: 'openai' }),
      null
    );
    expect(JSON.parse(openai.model)).toEqual({
      id: 'sonnet',
      api: 'openai-completions',
      models: ['sonnet', 'opus'],
    });
  });

  it('writes the full model list into the OpenClaw spec', () => {
    const request = providerSaveRequest(
      provision({ agentId: 'openclaw', protocol: 'openai' }),
      null
    );
    expect(JSON.parse(request.model)).toEqual({
      id: 'sonnet',
      models: ['sonnet', 'opus'],
    });
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

  it('does not append a second /v1 when the official gateway is already versioned', () => {
    const request = openCodeConnectRequest(
      provision({
        agentId: 'opencode',
        protocol: 'anthropic',
        baseUrl: 'https://model.xforever.xin',
      })
    );
    expect(request.base_url).toBe(`${MODEL_GATEWAY_ORIGIN}/v1`);
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

describe('dshProviderSaveRequest', () => {
  it('builds a custom gateway provider payload for DeepSeek Harness', () => {
    const request = dshProviderSaveRequest(
      provision({
        agentId: 'deepseek_harness',
        protocol: 'openai',
        baseUrl: 'https://site.test/api/router/v1',
      }),
      false
    );
    expect(request).toEqual({
      id: ROUTER_OPENCODE_PROVIDER_ID,
      display_name: ROUTER_PROVIDER_NAME,
      notes: null,
      api: 'openai-completions',
      base_url: 'https://site.test/api/router/v1',
      api_key: 'vxr-test',
      models: [
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'opus', name: 'Opus' },
      ],
      set_default: false,
      default_model: 'sonnet',
    });
  });
});

describe('officialModelBaseUrl', () => {
  it('keeps a user gateway and only rewrites the official model host', () => {
    expect(officialModelBaseUrl('codex', 'https://gateway.example/v1')).toBe(
      'https://gateway.example/v1'
    );
    expect(
      officialModelBaseUrl('claude_code', 'https://api.anthropic.com')
    ).toBe('https://api.anthropic.com');
    expect(officialModelBaseUrl('codex', 'not a url')).toBe('not a url');
  });

  it('uses the model host root for Claude and Gemini and /v1 for OpenAI clients', () => {
    expect(
      officialModelBaseUrl('claude_code', 'https://model.xforever.xin')
    ).toBe(MODEL_GATEWAY_ORIGIN);
    expect(officialModelBaseUrl('gemini', 'https://model.dimo-ai.com/v1')).toBe(
      MODEL_GATEWAY_ORIGIN
    );
    expect(
      officialModelBaseUrl('antigravity', 'https://model.xforever.xin/v1')
    ).toBe(MODEL_GATEWAY_ORIGIN);
    expect(officialModelBaseUrl('codex', 'https://model.xforever.xin')).toBe(
      `${MODEL_GATEWAY_ORIGIN}/v1`
    );
    expect(
      officialModelBaseUrl('opencode', 'https://model.dimo-ai.com/v1')
    ).toBe(`${MODEL_GATEWAY_ORIGIN}/v1`);
    expect(
      officialModelBaseUrl(
        'deepseek_harness',
        'https://vibex.xforever.xin/api/router'
      )
    ).toBe(`${MODEL_GATEWAY_ORIGIN}/v1`);
    expect(
      officialModelBaseUrl('claude_code', 'https://dimo-ai.com/api/router/v1')
    ).toBe(MODEL_GATEWAY_ORIGIN);
  });

  it('writes the normalized official URL onto the ModelRouter preset only', () => {
    const saved = providerSaveRequest(
      provision({
        agentId: 'codex',
        protocol: 'openai',
        baseUrl: 'https://model.xforever.xin',
      }),
      'preset-1'
    );
    expect(saved.id).toBe('preset-1');
    expect(saved.name).toBe(ROUTER_PROVIDER_NAME);
    expect(saved.api_url).toBe(`${MODEL_GATEWAY_ORIGIN}/v1`);

    const custom = providerSaveRequest(
      provision({
        agentId: 'codex',
        protocol: 'openai',
        baseUrl: 'https://gateway.example/v1',
      }),
      'user-preset'
    );
    expect(custom.id).toBe('user-preset');
    expect(custom.api_url).toBe('https://gateway.example/v1');
  });
});

describe('supportsModelRouter', () => {
  it('offers the entry for all agents that support custom model gateways', () => {
    expect(supportsModelRouter('codex')).toBe(true);
    expect(supportsModelRouter('cline')).toBe(true);
    expect(supportsModelRouter('openclaw')).toBe(true);
    expect(supportsModelRouter('hermes')).toBe(true);
    expect(supportsModelRouter('omp')).toBe(true);
    expect(supportsModelRouter('codebuddy')).toBe(true);
    expect(supportsModelRouter('qoder')).toBe(true);
    expect(supportsModelRouter('auggie')).toBe(true);
    expect(supportsModelRouter('trae')).toBe(true);
    expect(supportsModelRouter('command_code')).toBe(true);
    expect(supportsModelRouter('mimo_code')).toBe(true);
    expect(supportsModelRouter('deepseek_harness')).toBe(true);
    expect(supportsModelRouter('gemini')).toBe(true);
    expect(supportsModelRouter('antigravity')).toBe(true);
    expect(supportsModelRouter('cursor')).toBe(false);
    expect(supportsModelRouter('kiro')).toBe(false);
  });
});
