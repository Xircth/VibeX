import type {
  AgentModelProviderSaveRequest,
  DshProviderSaveRequest,
  OpenCodeProviderConnectRequest,
} from 'shared/types';

import type { RouterProvision } from './account';

/**
 * Agents whose provider settings offer ModelRouter. Kept in step with the
 * site's ROUTER_AGENTS / MARKET_AGENTS: the site offers one-click setup for
 * agents listed here, and the desktop offers the entry where it can write a
 * working preset.
 */
export const MODEL_ROUTER_AGENTS = [
  'claude_code',
  'codex',
  'gemini',
  'antigravity',
  'kimi_code',
  'deepseek_harness',
  'grok',
  'zcode',
  'qoder',
  'opencode',
  'pi',
  'omp',
  'cline',
  'openclaw',
  'hermes',
  'codebuddy',
  'trae',
  'auggie',
  'command_code',
  'mimo_code',
] as const;

export function supportsModelRouter(agentId: string) {
  return (MODEL_ROUTER_AGENTS as readonly string[]).includes(agentId);
}

/** One preset per agent: provisioning again updates it instead of piling up copies. */
export const ROUTER_PROVIDER_NAME = 'VibeX ModelRouter';
export const ROUTER_OPENCODE_PROVIDER_ID = 'vibex-modelrouter';

/** The chosen model first, then the rest the key can reach. */
function orderedModels(provision: RouterProvision) {
  return [
    provision.model,
    ...provision.models.filter((model) => model.id !== provision.model.id),
  ];
}

/**
 * The `model` field is agent-specific: most agents take a bare model id, Pi /
 * OMP / OpenClaw and Grok take a JSON spec that also names the wire protocol
 * or model list.
 */
function modelField(provision: RouterProvision) {
  const ids = orderedModels(provision).map((model) => model.id);
  if (provision.agentId === 'pi' || provision.agentId === 'omp') {
    return JSON.stringify({
      id: provision.model.id,
      api:
        provision.protocol === 'anthropic'
          ? 'anthropic-messages'
          : 'openai-completions',
      models: ids,
    });
  }
  if (provision.agentId === 'openclaw') {
    return JSON.stringify({
      id: provision.model.id,
      models: ids,
    });
  }
  if (provision.agentId === 'grok') {
    return JSON.stringify({
      id: provision.model.id,
      api_backend: 'responses',
      context_window: null,
      models: ids,
    });
  }
  return provision.model.id;
}

export function providerSaveRequest(
  provision: RouterProvision,
  existingId: string | null
): AgentModelProviderSaveRequest {
  return {
    id: existingId,
    name: ROUTER_PROVIDER_NAME,
    agent_id: provision.agentId,
    api_url: provision.baseUrl,
    api_key: provision.apiKey,
    model: modelField(provision),
  };
}

export function openCodeConnectRequest(
  provision: RouterProvision,
  enabled = true
): OpenCodeProviderConnectRequest {
  const anthropic = provision.protocol === 'anthropic';
  return {
    provider_id: ROUTER_OPENCODE_PROVIDER_ID,
    name: ROUTER_PROVIDER_NAME,
    npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    api: null,
    // The Anthropic SDK package expects the versioned root; the gateway's
    // Anthropic base is unversioned because Claude Code appends /v1 itself.
    base_url: anthropic ? `${provision.baseUrl}/v1` : provision.baseUrl,
    api_key: provision.apiKey,
    models: orderedModels(provision).map((model) => ({
      id: model.id,
      name: model.name,
    })),
    enabled,
  };
}

export function dshProviderSaveRequest(
  provision: RouterProvision,
  setDefault = true
): DshProviderSaveRequest {
  return {
    id: ROUTER_OPENCODE_PROVIDER_ID,
    display_name: ROUTER_PROVIDER_NAME,
    notes: null,
    api: 'openai-completions',
    base_url: provision.baseUrl,
    api_key: provision.apiKey,
    models: orderedModels(provision).map((model) => ({
      id: model.id,
      name: model.name,
    })),
    set_default: setDefault,
    default_model: provision.model.id,
  };
}

