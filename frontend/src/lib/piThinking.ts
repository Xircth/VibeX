export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export type PiThinkingLevelMap = Partial<
  Record<PiThinkingLevel, string | null>
>;

export type PiModelReasoning = {
  enabled: boolean;
  levels: PiThinkingLevel[];
  wireValues: Partial<Record<PiThinkingLevel, string>>;
};

export const NO_PI_REASONING: PiModelReasoning = {
  enabled: false,
  levels: [],
  wireValues: {},
};

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

export function implicitWireValue(level: PiThinkingLevel): string {
  return level === 'off' ? 'none' : level;
}

export function levelsFromMap(
  map: PiThinkingLevelMap | null | undefined
): PiThinkingLevel[] {
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh') return mapped !== undefined;
    return true;
  });
}

export function reasoningFromModel(
  reasoning: boolean | null | undefined,
  map: PiThinkingLevelMap | null | undefined
): PiModelReasoning {
  const levels = levelsFromMap(map);
  const wireValues: Partial<Record<PiThinkingLevel, string>> = {};
  for (const level of levels) {
    const mapped = map?.[level];
    if (typeof mapped === 'string' && mapped !== implicitWireValue(level)) {
      wireValues[level] = mapped;
    }
  }
  return { enabled: reasoning === true, levels, wireValues };
}

export function reasoningToMap(
  reasoning: PiModelReasoning
): PiThinkingLevelMap {
  const map: PiThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    if (!reasoning.levels.includes(level)) {
      map[level] = null;
      continue;
    }
    const override = reasoning.wireValues[level]?.trim();
    if (override) {
      map[level] = override;
    } else if (level === 'off' || level === 'xhigh') {
      map[level] = implicitWireValue(level);
    }
  }
  return map;
}

export function toggleThinkingLevel(
  levels: PiThinkingLevel[],
  level: PiThinkingLevel
): PiThinkingLevel[] {
  const next = levels.includes(level)
    ? levels.filter((item) => item !== level)
    : [...levels, level];
  return PI_THINKING_LEVELS.filter((item) => next.includes(item));
}
