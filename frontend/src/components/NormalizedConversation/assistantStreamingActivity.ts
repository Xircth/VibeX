export const STREAMING_ACTIVITY_VERBS = [
  'Cooking',
  'Creating',
  'Driving',
  'Swimming',
  'Thinking',
  'Flying',
  'Researching',
  'Brewing',
  'Crafting',
  'Pondering',
  'Computing',
  'Exploring',
  'Building',
  'Sketching',
  'Mapping',
  'Sculpting',
  'Weaving',
  'Composing',
  'Distilling',
  'Forging',
  'Hatching',
  'Noodling',
  'Percolating',
  'Ruminating',
  'Synthesizing',
] as const;

export const STREAMING_ACTIVITY_INTERVAL_MS = 1400;

const TERMINAL_TURN_PHASES = new Set([
  'settled',
  'failed',
  'cancelled',
  'interrupted',
  'persisted',
]);

export function isTerminalTurnPhase(phase: string): boolean {
  return TERMINAL_TURN_PHASES.has(phase);
}

export function shouldShowAssistantStreamingStatus({
  phase,
  hasTurnError = false,
}: {
  phase: string;
  hasTurnError?: boolean;
}): boolean {
  return phase === 'streaming' && !hasTurnError;
}

export function nextStreamingActivityVerb(
  verbs: readonly string[] = STREAMING_ACTIVITY_VERBS,
  current?: string,
  random: () => number = Math.random
): string {
  if (verbs.length === 0) return 'Thinking';
  const pool = current ? verbs.filter((verb) => verb !== current) : [...verbs];
  if (pool.length === 0) return current ?? verbs[0] ?? 'Thinking';
  return pool[Math.floor(random() * pool.length)] ?? verbs[0] ?? 'Thinking';
}
