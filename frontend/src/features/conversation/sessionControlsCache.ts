import type { AgentSessionConfigOption, AgentSessionMode } from 'shared/types';

/**
 * Last-known agent-advertised session controls, cached per executor.
 *
 * ACP only advertises modes/config options once a session exists, so a brand-new
 * conversation has nothing to render until the first `session/new`. Caching the
 * most recent advertisement per agent type lets the composer show the agent's
 * REAL modes/models before the session is established; the picked values are
 * applied as overrides on the first turn. The cache is display-seeding only —
 * live advertisements always replace it.
 */
export type CachedSessionControls = {
  modes: AgentSessionMode[];
  configOptions: AgentSessionConfigOption[];
};

const STORAGE_KEY = 'vibex.acpSessionControls.v1';

type CacheShape = Record<string, CachedSessionControls>;

function readAll(): CacheShape {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CacheShape) : {};
  } catch {
    return {};
  }
}

export function readCachedSessionControls(
  executor: string | null | undefined
): CachedSessionControls | null {
  if (!executor) return null;
  const entry = readAll()[executor];
  if (!entry) return null;
  return {
    modes: Array.isArray(entry.modes) ? entry.modes : [],
    configOptions: Array.isArray(entry.configOptions) ? entry.configOptions : [],
  };
}

export function writeCachedSessionControls(
  executor: string | null | undefined,
  controls: CachedSessionControls
): void {
  if (!executor) return;
  if (controls.modes.length === 0 && controls.configOptions.length === 0) return;
  try {
    const all = readAll();
    all[executor] = controls;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Cache is best-effort; ignore quota/serialization failures.
  }
}
