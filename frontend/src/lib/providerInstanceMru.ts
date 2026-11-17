import {
  LOCAL_PROVIDER_INSTANCE_ID,
  canonicalProviderAgentId,
  type ProviderInstanceConfig,
  type SupportedMultiInstanceAgentId,
} from '@/lib/providerInstancesApi';

const STORAGE_KEY = 'dimo:provider-instance-mru';

type MruMap = Partial<Record<SupportedMultiInstanceAgentId, string>>;

function readMruMap(): MruMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as MruMap;
  } catch {
    return {};
  }
}

function writeMruMap(map: MruMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota or private-mode failures.
  }
}

export function getMruProviderInstanceId(
  agentId: string | null | undefined
): string | null {
  const canonical = canonicalProviderAgentId(agentId);
  if (!canonical) return null;
  const value = readMruMap()[canonical];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function recordMruProviderInstanceId(
  agentId: string | null | undefined,
  instanceId: string | null | undefined
): void {
  const canonical = canonicalProviderAgentId(agentId);
  if (!canonical) return;
  const trimmed = typeof instanceId === 'string' ? instanceId.trim() : '';
  const nextValue =
    !trimmed || trimmed.toLowerCase() === LOCAL_PROVIDER_INSTANCE_ID
      ? LOCAL_PROVIDER_INSTANCE_ID
      : trimmed;
  const current = readMruMap();
  if (current[canonical] === nextValue) return;
  writeMruMap({
    ...current,
    [canonical]: nextValue,
  });
}

export function resolvePreferredProviderInstanceId(
  agentId: string | null | undefined,
  instances: ReadonlyArray<ProviderInstanceConfig>
): string {
  const canonical = canonicalProviderAgentId(agentId);
  if (!canonical) return LOCAL_PROVIDER_INSTANCE_ID;

  const customInstances = instances.filter(
    (item) =>
      canonicalProviderAgentId(item.agentId) === canonical &&
      item.instanceId.trim().toLowerCase() !== LOCAL_PROVIDER_INSTANCE_ID
  );

  const mru = getMruProviderInstanceId(canonical);
  if (mru === LOCAL_PROVIDER_INSTANCE_ID) {
    return LOCAL_PROVIDER_INSTANCE_ID;
  }
  if (mru && customInstances.some((item) => item.instanceId === mru)) {
    return mru;
  }

  const defaultCustom = customInstances.find((item) => item.isDefault);
  return defaultCustom?.instanceId ?? LOCAL_PROVIDER_INSTANCE_ID;
}
