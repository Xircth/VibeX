import type {
  AgentId,
  AgentModelCatalogView,
  CodexModelCatalogConfigRequest,
  CodexModelCatalogConfigView,
} from 'shared/types';

import {
  NO_PI_REASONING,
  reasoningFromModel,
  reasoningToMap,
  thinkingLevelMapFromUnknown,
} from '@/lib/piThinking';

import type { CustomModelTestState } from '../CodexModelCatalogEditor';

import { PI_PROTOCOLS } from './constants';
import type { ClaudeModelSpec, GrokModelSpec, PiModelSpec } from './types';

export function customModelVerified(state: CustomModelTestState | undefined) {
  return typeof state === 'object' && state.ok;
}

export function parseCopiedModel(model: string): unknown {
  if (!model.trim()) return null;
  try {
    return JSON.parse(model) as unknown;
  } catch {
    return model;
  }
}

export function writePiReasoning(
  payload: Record<string, unknown>,
  next: PiModelSpec
) {
  if (next.reasoning.enabled) {
    payload.reasoning = true;
    payload.thinkingLevelMap = reasoningToMap(next.reasoning);
    delete payload.thinking_level_map;
    if (next.thinkingLevel) payload.thinkingLevel = next.thinkingLevel;
    else delete payload.thinkingLevel;
    delete payload.thinking_level;
    return;
  }
  if (
    Object.hasOwn(next.raw, 'reasoning') ||
    Object.hasOwn(next.raw, 'thinkingLevelMap') ||
    Object.hasOwn(next.raw, 'thinking_level_map') ||
    Object.hasOwn(next.raw, 'thinkingLevel') ||
    Object.hasOwn(next.raw, 'thinking_level')
  ) {
    payload.reasoning = false;
    delete payload.thinkingLevelMap;
    delete payload.thinking_level_map;
    delete payload.thinkingLevel;
    delete payload.thinking_level;
  }
}

export function parsePiModel(value: string): PiModelSpec {
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      api?: unknown;
      reasoning?: unknown;
      thinkingLevel?: unknown;
      thinking_level?: unknown;
      thinkingLevelMap?: unknown;
      thinking_level_map?: unknown;
    };
    if (parsed && typeof parsed === 'object') {
      const map = thinkingLevelMapFromUnknown(
        parsed.thinkingLevelMap ?? parsed.thinking_level_map
      );
      return {
        id: typeof parsed.id === 'string' ? parsed.id : '',
        api:
          typeof parsed.api === 'string' &&
          PI_PROTOCOLS.includes(parsed.api as (typeof PI_PROTOCOLS)[number])
            ? parsed.api
            : 'openai-responses',
        reasoning: reasoningFromModel(
          typeof parsed.reasoning === 'boolean' ? parsed.reasoning : null,
          map
        ),
        thinkingLevel:
          typeof parsed.thinkingLevel === 'string'
            ? parsed.thinkingLevel
            : typeof parsed.thinking_level === 'string'
              ? parsed.thinking_level
              : '',
        raw: parsed as Record<string, unknown>,
      };
    }
  } catch {
    /* plain model id */
  }
  return {
    id: value,
    api: 'openai-responses',
    reasoning: NO_PI_REASONING,
    thinkingLevel: '',
    raw: {},
  };
}

export function parseGrokModel(value: string): GrokModelSpec {
  try {
    const parsed = JSON.parse(value) as {
      id?: string;
      model?: string;
      api_backend?: string;
      context_window?: number | string | null;
    };
    if (parsed && typeof parsed === 'object') {
      return {
        id: String(parsed.id ?? parsed.model ?? ''),
        api_backend: parsed.api_backend || 'responses',
        context_window:
          parsed.context_window == null ? '' : String(parsed.context_window),
        raw: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Plain model id from an older preset.
  }
  return {
    id: value,
    api_backend: 'responses',
    context_window: '',
    raw: {},
  };
}

export function parseClaudeModel(value: string): ClaudeModelSpec {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { values: {}, raw: {} };
    return {
      values: Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      raw: parsed as Record<string, unknown>,
    };
  } catch {
    return value.trim()
      ? { values: { main: value.trim() }, raw: {} }
      : { values: {}, raw: {} };
  }
}

export function reindexCustomModelTests(
  current: Record<number, CustomModelTestState>,
  removedIndex: number
): Record<number, CustomModelTestState> {
  const next: Record<number, CustomModelTestState> = {};
  for (const [key, value] of Object.entries(current)) {
    const currentIndex = Number(key);
    if (currentIndex < removedIndex) next[currentIndex] = value;
    else if (currentIndex > removedIndex) next[currentIndex - 1] = value;
  }
  return next;
}

export function selectedModelIds(value: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const next = id.trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    ids.push(next);
  };
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      default?: unknown;
      main?: unknown;
      models?: unknown;
    };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.id === 'string') add(parsed.id);
      if (typeof parsed.default === 'string') add(parsed.default);
      if (typeof parsed.main === 'string') add(parsed.main);
      if (Array.isArray(parsed.models)) {
        for (const item of parsed.models) {
          if (typeof item === 'string') add(item);
          else if (
            item &&
            typeof item === 'object' &&
            typeof (item as { id?: unknown }).id === 'string'
          ) {
            add((item as { id: string }).id);
          }
        }
      }
      if (ids.length) return ids;
    }
  } catch {
    /* plain model id */
  }
  if (value.trim()) add(value);
  return ids;
}

/**
 * The models the picker offers: the ones the user enabled in the detection
 * panel, plus everything the last detection returned.
 *
 * Reading only the `models` list matters. The primary model lives in `id`
 * (or, for Claude, in the mapping keys), and feeding that back in would make
 * a typed model id promote itself into the picker mid-keystroke — the field
 * would turn into a dropdown while the user was still typing.
 */
export function providerModelChoices(
  model: string,
  catalog: AgentModelCatalogView | null
): string[] {
  return [
    ...new Set([
      ...enabledModelIds(model),
      ...(catalog?.models ?? []).map((item) => item.id),
    ]),
  ];
}

/** The `models` list as written, ignoring the primary/default model keys. */
export function enabledModelIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as { models?: unknown };
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.models)
    ) {
      return [];
    }
    const ids: string[] = [];
    for (const item of parsed.models) {
      if (typeof item === 'string' && item.trim()) ids.push(item.trim());
      else if (
        item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string'
      ) {
        const id = (item as { id: string }).id.trim();
        if (id) ids.push(id);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function serializeSelectedModels(
  agentId: AgentId,
  current: string,
  ids: string[]
): string {
  if (agentId === 'grok') {
    const parsed = parseGrokModel(current);
    return JSON.stringify({
      ...parsed.raw,
      id: ids[0] ?? '',
      api_backend: parsed.api_backend,
      context_window: parsed.context_window
        ? Number(parsed.context_window)
        : null,
      models: ids,
    });
  }
  if (agentId === 'pi') {
    const parsed = parsePiModel(current);
    return JSON.stringify({
      ...parsed.raw,
      id: ids[0] ?? '',
      api: parsed.api,
      models: ids,
    });
  }
  if (ids.length <= 1) return ids[0] ?? '';
  return JSON.stringify({ default: ids[0], models: ids });
}

export function selectedDetectedIds(
  agentId: AgentId,
  model: string,
  catalog: AgentModelCatalogView | null,
  codexConfig: CodexModelCatalogConfigView | null
): string[] {
  const detected = new Set((catalog?.models ?? []).map((item) => item.id));
  if (!detected.size) return [];
  if (agentId === 'codex') {
    const draft = mergeCodexConfigDraft(parseCodexModel(model), codexConfig);
    return [
      ...new Set([
        ...draft.customs.map((custom) => custom.slug),
        ...(draft.default_model ? [draft.default_model] : []),
      ]),
    ].filter((id) => detected.has(id));
  }
  if (agentId === 'claude_code') {
    return [...new Set(Object.values(parseClaudeModel(model).values))].filter(
      (id) => detected.has(id)
    );
  }
  return selectedModelIds(model).filter((id) => detected.has(id));
}

export function parseCodexModel(value: string): CodexModelCatalogConfigRequest {
  try {
    const parsed = JSON.parse(value) as Partial<CodexModelCatalogConfigRequest>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    return {
      customs: Array.isArray(parsed.customs) ? parsed.customs : [],
      excluded_officials: Array.isArray(parsed.excluded_officials)
        ? parsed.excluded_officials
        : [],
      default_model:
        typeof parsed.default_model === 'string' ? parsed.default_model : null,
    };
  } catch {
    return {
      customs: [],
      excluded_officials: [],
      default_model: value.trim() || null,
    };
  }
}

export function serializeCodexModel(value: CodexModelCatalogConfigRequest) {
  if (
    !value.customs.length &&
    !value.excluded_officials.length &&
    !value.default_model
  ) {
    return '';
  }
  return JSON.stringify(value);
}

export function mergeCodexConfigDraft(
  draft: CodexModelCatalogConfigRequest,
  config: CodexModelCatalogConfigView | null
): CodexModelCatalogConfigRequest {
  if (
    draft.default_model ||
    draft.customs.length ||
    draft.excluded_officials.length ||
    !config
  ) {
    return draft;
  }
  return {
    customs: config.customs,
    excluded_officials: config.excluded_officials,
    default_model: config.default_model,
  };
}
