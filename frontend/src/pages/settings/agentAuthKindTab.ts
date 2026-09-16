import type { AgentAuthModeKind, AgentId } from 'shared/types';

const STORAGE_KEY = 'vibex:agent-auth-kind-tab';
const AUTH_KINDS: readonly AgentAuthModeKind[] = [
  'subscription',
  'official_api',
  'provider',
];

type AuthKindTabMap = Partial<Record<AgentId, AgentAuthModeKind>>;

let memoryFallback: AuthKindTabMap = {};

function isAuthKind(value: unknown): value is AgentAuthModeKind {
  return (
    typeof value === 'string' &&
    AUTH_KINDS.includes(value as AgentAuthModeKind)
  );
}

function readMap(): AuthKindTabMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry) =>
        isAuthKind(entry[1])
      )
    ) as AuthKindTabMap;
  } catch {
    return memoryFallback;
  }
}

function writeMap(next: AuthKindTabMap) {
  memoryFallback = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }
}

export function rememberAgentAuthKindTab(
  agentId: AgentId,
  kind: AgentAuthModeKind
) {
  if (!isAuthKind(kind)) return;
  const current = readMap();
  if (current[agentId] === kind) return;
  writeMap({ ...current, [agentId]: kind });
}

export function peekAgentAuthKindTab(
  agentId: AgentId
): AgentAuthModeKind | null {
  return readMap()[agentId] ?? null;
}

export function clearAgentAuthKindTab(agentId: AgentId) {
  const current = readMap();
  if (!(agentId in current)) return;
  const next = { ...current };
  delete next[agentId];
  writeMap(next);
}

export function clearAllAgentAuthKindTabs() {
  memoryFallback = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures in tests and locked environments.
  }
}
