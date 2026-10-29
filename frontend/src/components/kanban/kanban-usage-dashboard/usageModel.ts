import type {
  ProjectUsageSourcedTokens,
  ProjectUsageTokenCounts,
} from '@/lib/api';
import { UNRESOLVED_MODEL_ALIASES, type ModelCostRates } from './types';

export function isUnresolvedModelAlias(
  model: string | null | undefined
): boolean {
  if (!model) return false;
  return UNRESOLVED_MODEL_ALIASES.has(model.trim().toLowerCase());
}

export function modelMatches(model: string, candidates: string[]): boolean {
  const lower = model.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate));
}

export function getModelCostRates(
  model: string | null | undefined
): ModelCostRates | null {
  if (!model || model === 'unprovided' || model === 'unknown') {
    return null;
  }

  if (modelMatches(model, ['claude', 'sonnet', 'opus', 'haiku'])) {
    if (
      modelMatches(model, [
        'claude-opus-5',
        'opus-5',
        'claude-opus-4-6',
        'claude-opus-4.6',
        'opus-4-6',
        'opus-4.6',
      ])
    ) {
      return { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 };
    }
    if (
      modelMatches(model, [
        'claude-opus-4-1',
        'claude-opus-4.1',
        'claude-opus-4',
        'claude-opus-3',
        'opus-4-1',
        'opus-4',
        'opus-3',
      ])
    ) {
      return { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 };
    }
    if (
      modelMatches(model, [
        'claude-haiku-4-5',
        'claude-haiku-4.5',
        'haiku-4-5',
        'haiku-4.5',
      ])
    ) {
      return { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };
    }
    if (modelMatches(model, ['claude-3-5-haiku', 'haiku-3.5', 'haiku-3-5'])) {
      return { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 };
    }
    if (modelMatches(model, ['claude-3-haiku', 'haiku-3'])) {
      return { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 };
  }

  if (modelMatches(model, ['gpt', 'codex', 'o1', 'o3', 'o4'])) {
    if (modelMatches(model, ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1', 'gpt-6'])) {
      return { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 };
    }
    if (modelMatches(model, ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5-6'])) {
      return { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.4 };
    }
    if (modelMatches(model, ['gpt-5.5', 'gpt-5-5'])) {
      return { input: 5.0, output: 30.0, cacheWrite: 0, cacheRead: 0.5 };
    }
    if (modelMatches(model, ['gpt-5.4-mini'])) {
      return { input: 0.75, output: 4.5, cacheWrite: 0, cacheRead: 0.075 };
    }
    if (modelMatches(model, ['gpt-5.4-nano'])) {
      return { input: 0.2, output: 1.25, cacheWrite: 0, cacheRead: 0.02 };
    }
    if (modelMatches(model, ['gpt-5.4', 'gpt-5-4'])) {
      return { input: 2.5, output: 15.0, cacheWrite: 0, cacheRead: 0.25 };
    }
    if (modelMatches(model, ['gpt-5.2-pro'])) {
      return { input: 21.0, output: 168.0, cacheWrite: 0, cacheRead: 0 };
    }
    if (modelMatches(model, ['gpt-5-pro'])) {
      return { input: 15.0, output: 120.0, cacheWrite: 0, cacheRead: 0 };
    }
    if (modelMatches(model, ['gpt-5.2', 'gpt-5.2-chat', 'gpt-5.2-codex'])) {
      return { input: 1.75, output: 14.0, cacheWrite: 0, cacheRead: 0.175 };
    }
    if (modelMatches(model, ['gpt-5.1-codex-mini', 'gpt-5-mini'])) {
      return { input: 0.25, output: 2.0, cacheWrite: 0, cacheRead: 0.025 };
    }
    if (modelMatches(model, ['gpt-5-nano'])) {
      return { input: 0.05, output: 0.4, cacheWrite: 0, cacheRead: 0.005 };
    }
    if (
      modelMatches(model, [
        'gpt-5.1',
        'gpt-5.1-chat',
        'gpt-5.1-codex-max',
        'gpt-5.1-codex',
        'gpt-5-codex',
        'gpt-5-chat',
        'gpt-5',
      ])
    ) {
      return { input: 1.25, output: 10.0, cacheWrite: 0, cacheRead: 0.125 };
    }
    if (modelMatches(model, ['codex-mini-latest'])) {
      return { input: 1.5, output: 6.0, cacheWrite: 0, cacheRead: 0.375 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 0, cacheRead: 0.3 };
  }

  if (modelMatches(model, ['grok'])) {
    if (
      modelMatches(model, [
        'grok-4-fast',
        'grok-4-1-fast',
        'grok-4.1-fast',
        'grok-code-fast',
      ])
    ) {
      return { input: 0.2, output: 0.5, cacheWrite: 0, cacheRead: 0.05 };
    }
    if (
      modelMatches(model, ['grok-4.3', 'grok-4-3', 'grok-4.20', 'grok-4-20'])
    ) {
      return { input: 1.25, output: 2.5, cacheWrite: 0, cacheRead: 0.2 };
    }
    if (
      modelMatches(model, [
        'grok-4.7',
        'grok-4-7',
        'grok-4.6',
        'grok-4-6',
        'grok-4.5',
        'grok-4-5',
      ])
    ) {
      return { input: 2.0, output: 6.0, cacheWrite: 0, cacheRead: 0.5 };
    }
    if (modelMatches(model, ['grok-build'])) {
      return { input: 1.0, output: 2.0, cacheWrite: 0, cacheRead: 0.2 };
    }
    if (modelMatches(model, ['grok-3-mini', 'grok-2-mini'])) {
      return { input: 0.3, output: 0.5, cacheWrite: 0, cacheRead: 0.075 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 0, cacheRead: 0.75 };
  }

  if (modelMatches(model, ['gemini'])) {
    if (modelMatches(model, ['flash'])) {
      return { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.03 };
    }
    return { input: 1.25, output: 10.0, cacheWrite: 0, cacheRead: 0.125 };
  }

  if (modelMatches(model, ['deepseek'])) {
    return { input: 0.28, output: 0.42, cacheWrite: 0, cacheRead: 0.028 };
  }

  if (modelMatches(model, ['kimi', 'moonshot'])) {
    return { input: 0.6, output: 2.5, cacheWrite: 0, cacheRead: 0.1 };
  }

  if (modelMatches(model, ['glm'])) {
    return { input: 0.6, output: 2.2, cacheWrite: 0, cacheRead: 0.11 };
  }

  if (modelMatches(model, ['minimax'])) {
    return { input: 0.3, output: 1.2, cacheWrite: 0.375, cacheRead: 0.03 };
  }

  if (modelMatches(model, ['qwen'])) {
    return { input: 0.4, output: 1.2, cacheWrite: 0, cacheRead: 0.04 };
  }

  return null;
}

export function hasTokenCounts(
  counts: ProjectUsageTokenCounts | null | undefined
): counts is ProjectUsageTokenCounts {
  if (!counts) return false;
  return (
    counts.total_tokens != null ||
    counts.input_tokens != null ||
    counts.output_tokens != null ||
    counts.cache_write_tokens != null ||
    counts.cache_read_tokens != null
  );
}

export function preferredTokenCounts(
  tokens: ProjectUsageSourcedTokens
): ProjectUsageTokenCounts | null {
  if (hasTokenCounts(tokens.vendor_log)) {
    return tokens.vendor_log;
  }
  if (hasTokenCounts(tokens.protocol)) {
    return tokens.protocol;
  }
  return null;
}

export function preferredTokenTotal(
  tokens: ProjectUsageSourcedTokens
): number | null {
  const counts = preferredTokenCounts(tokens);
  if (!counts) return null;
  if (counts.total_tokens != null) return counts.total_tokens;
  if (counts.input_tokens != null || counts.output_tokens != null) {
    return (
      (counts.input_tokens ?? 0) +
      (counts.output_tokens ?? 0) +
      (counts.cache_write_tokens ?? 0) +
      (counts.cache_read_tokens ?? 0)
    );
  }
  return null;
}

export function estimateUsageCost(
  model: string | null | undefined,
  counts: ProjectUsageTokenCounts | null | undefined
): number | null {
  if (!counts || !hasTokenCounts(counts)) return null;
  const rates = getModelCostRates(model);
  if (!rates) return null;
  if (counts.input_tokens != null && counts.output_tokens != null) {
    const inputCost = (counts.input_tokens / 1_000_000) * rates.input;
    const outputCost = (counts.output_tokens / 1_000_000) * rates.output;
    const cacheWriteCost =
      ((counts.cache_write_tokens ?? 0) / 1_000_000) * rates.cacheWrite;
    const cacheReadCost =
      ((counts.cache_read_tokens ?? 0) / 1_000_000) * rates.cacheRead;
    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }
  if (counts.total_tokens != null) {
    return (counts.total_tokens / 1_000_000) * rates.input;
  }
  return null;
}
