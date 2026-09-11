import type { AgentManagementView, AgentUpdateCheckView } from 'shared/types';

import { agentManagementApi } from './api';
import { agentHasAcpUpdate, isAgentAcpUpdateCheckable } from './agentVersion';

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = 'vibex:agent-acp-updates';
const EVENT = 'vibex:agent-acp-updates';
const CHECK_CONCURRENCY = 2;

type CacheEntry = {
  at: number;
  available: boolean;
  currentVersion: string | null;
};

type Cache = Record<string, CacheEntry>;

let memoryCache: Cache | null = null;
const inFlight = new Map<string, Promise<boolean>>();

function readStore(): Cache {
  if (memoryCache) return memoryCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memoryCache = {};
      return memoryCache;
    }
    const parsed = JSON.parse(raw) as Cache;
    memoryCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

function writeStore(cache: Cache): void {
  memoryCache = cache;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(EVENT, { detail: availableFromCache(cache) })
    );
  }
}

function availableFromCache(
  cache: Cache,
  now = Date.now()
): Record<string, boolean> {
  const available: Record<string, boolean> = {};
  for (const [agentId, entry] of Object.entries(cache)) {
    if (entry.available && now - entry.at < CHECK_TTL_MS) {
      available[agentId] = true;
    }
  }
  return available;
}

function isFresh(entry: CacheEntry | undefined, currentVersion: string | null) {
  if (!entry) return false;
  if (Date.now() - entry.at >= CHECK_TTL_MS) return false;
  return entry.currentVersion === currentVersion;
}

export function readCachedAgentAcpUpdates(): Record<string, boolean> {
  return availableFromCache(readStore());
}

export function subscribeAgentAcpUpdates(
  listener: (available: Record<string, boolean>) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onCustom = (event: Event) => {
    listener((event as CustomEvent<Record<string, boolean>>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    memoryCache = null;
    listener(readCachedAgentAcpUpdates());
  };

  window.addEventListener(EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export function recordAgentAcpUpdateCheck(
  check: AgentUpdateCheckView,
  currentVersion?: string | null
): void {
  const available = agentHasAcpUpdate(check, currentVersion);
  const cache = { ...readStore() };
  cache[check.agent_id] = {
    at: Date.now(),
    available,
    currentVersion: currentVersion ?? check.acp_current ?? null,
  };
  writeStore(cache);
}

export function invalidateAgentAcpUpdate(agentId: string): void {
  const cache = readStore();
  if (!(agentId in cache)) return;
  const next = { ...cache };
  delete next[agentId];
  writeStore(next);
}

export function resetAgentAcpUpdatesForTests(): void {
  memoryCache = null;
  inFlight.clear();
  localStorage.removeItem(STORAGE_KEY);
}

async function checkOne(
  agent: AgentManagementView
): Promise<{ agentId: string; available: boolean }> {
  const currentVersion = agent.acp_version;
  const cached = readStore()[agent.agent_id];
  if (isFresh(cached, currentVersion)) {
    return { agentId: agent.agent_id, available: cached.available };
  }

  const pending = inFlight.get(agent.agent_id);
  if (pending) {
    return { agentId: agent.agent_id, available: await pending };
  }

  const request = (async () => {
    const check = await agentManagementApi.checkUpdate(agent.agent_id);
    const scoped = { ...check, agent_id: agent.agent_id };
    recordAgentAcpUpdateCheck(scoped, currentVersion);
    return agentHasAcpUpdate(scoped, currentVersion);
  })();

  inFlight.set(agent.agent_id, request);
  try {
    return { agentId: agent.agent_id, available: await request };
  } catch {
    return { agentId: agent.agent_id, available: false };
  } finally {
    inFlight.delete(agent.agent_id);
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export async function refreshAgentAcpUpdates(
  agents: AgentManagementView[]
): Promise<Record<string, boolean>> {
  const checkable = agents.filter(isAgentAcpUpdateCheckable);
  const results = await mapPool(checkable, CHECK_CONCURRENCY, checkOne);
  const available: Record<string, boolean> = {};
  for (const result of results) {
    if (result.available) available[result.agentId] = true;
  }
  return available;
}
