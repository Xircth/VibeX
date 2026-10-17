import type { AgentSessionConfigOption, JsonValue } from 'shared/types';
import { jsonValueToString } from '@/components/tasks/follow-up/SessionConfigOptionSelectors';

function normalizeDefaultToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isThoughtLevelDefaultToken(token: string): boolean {
  return (
    token === 'reasoning' ||
    token === 'reasoningeffort' ||
    token === 'thoughteffort' ||
    token === 'thoughtlevel' ||
    token === 'thinkinglevel' ||
    token === 'effort' ||
    token.includes('reason') ||
    token.includes('thought') ||
    token.includes('thinking') ||
    token.includes('effort')
  );
}

function optionMatchesDefaultKey(
  option: AgentSessionConfigOption,
  optionId: string
): boolean {
  if (option.key === optionId) return true;
  const requested = normalizeDefaultToken(optionId);
  if (!isThoughtLevelDefaultToken(requested)) return false;
  const id = normalizeDefaultToken(option.key);
  return option.category === 'thought_level' || isThoughtLevelDefaultToken(id);
}

export function advertisedOptionForDefault(
  options: AgentSessionConfigOption[],
  optionId: string
): AgentSessionConfigOption | undefined {
  return (
    options.find((option) => option.key === optionId) ??
    options.find((option) => optionMatchesDefaultKey(option, optionId))
  );
}

function typedDefaultValue(
  option: AgentSessionConfigOption,
  serialized: string
): JsonValue | undefined {
  const advertisedChoice = (option.choices ?? []).find(
    (choice) => jsonValueToString(choice.value) === serialized
  );
  if (advertisedChoice) return advertisedChoice.value;
  if (jsonValueToString(option.value ?? null) === serialized) {
    return option.value ?? serialized;
  }
  if (typeof option.value === 'boolean') {
    return serialized === 'true';
  }
  return undefined;
}

/**
 * Map create-form selections onto the catalog's advertised option keys.
 * Vendor thought-level aliases (`effort`, `reasoning_effort`, `thinking_level`)
 * are the same control. Unadvertised live values (pre-update model ids) are
 * dropped so a save is not rejected after an ACP schema change.
 */
export function sessionDefaultsWritePayload(
  advertisedOptions: AgentSessionConfigOption[],
  serializedValues: Record<string, string>
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const [optionId, serialized] of Object.entries(serializedValues)) {
    if (serialized === undefined) continue;
    const option = advertisedOptionForDefault(advertisedOptions, optionId);
    if (!option) continue;
    const value = typedDefaultValue(option, serialized);
    if (value === undefined) continue;
    payload[option.key] = value;
  }
  return payload;
}
