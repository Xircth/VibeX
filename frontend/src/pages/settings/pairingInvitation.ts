export type PairingReachability = {
  origin: string;
  kind: string;
};

export type PairingListenAddress = {
  origin: string;
  interface?: string;
};

export type PairingDisplayOrigin = {
  origin: string;
  kind: 'lan' | 'loopback' | 'published';
  interface?: string;
};

export function isLoopbackOrigin(origin: string): boolean {
  return /127\.0\.0\.1|localhost|\[::1\]/i.test(origin);
}

function displayKind(
  origin: string,
  kind?: string
): PairingDisplayOrigin['kind'] {
  if (isLoopbackOrigin(origin)) return 'loopback';
  if (!kind || kind === 'lan') return 'lan';
  return 'published';
}

export function pairingDisplayOrigins(
  reachability: PairingReachability[],
  hostUrls: string[] = [],
  listenAddresses: PairingListenAddress[] = []
): PairingDisplayOrigin[] {
  const interfaces = new Map(
    listenAddresses
      .filter((item) => item.origin.trim() && item.interface?.trim())
      .map((item) => [item.origin.trim(), item.interface!.trim()])
  );
  const rows: PairingDisplayOrigin[] = [];
  const seen = new Set<string>();
  const push = (origin: string, kind?: string) => {
    const value = origin.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    const iface = interfaces.get(value);
    rows.push(
      iface
        ? { origin: value, kind: displayKind(value, kind), interface: iface }
        : { origin: value, kind: displayKind(value, kind) }
    );
  };
  for (const item of reachability) push(item.origin, item.kind);
  for (const origin of hostUrls) push(origin);
  const rank = { published: 0, lan: 1, loopback: 2 };
  return rows.sort((left, right) => rank[left.kind] - rank[right.kind]);
}

export function pairingVisibleOrigins(
  origins: PairingDisplayOrigin[],
  expanded: boolean
): PairingDisplayOrigin[] {
  if (expanded) return origins;
  const reachable = origins.filter((item) => item.kind !== 'loopback');
  return reachable.length > 0 ? reachable : origins.slice(0, 1);
}

export const PAIRING_TTL_SECONDS = [300, 900, 1800, 3600] as const;
export type PairingTtlSeconds = (typeof PAIRING_TTL_SECONDS)[number];
export type PairingLiveStatus = 'waiting' | 'connected' | 'failed';

export function pairingLiveStatus(input: {
  expiresAt: string;
  now: number;
  issuedAt: number;
  devices: Array<{ created_at: string }>;
}): PairingLiveStatus {
  const connected = input.devices.some((device) => {
    const createdAt = Date.parse(device.created_at);
    return Number.isFinite(createdAt) && createdAt >= input.issuedAt - 2000;
  });
  if (connected) return 'connected';
  const expiresAt = Date.parse(input.expiresAt);
  if (Number.isFinite(expiresAt) && input.now >= expiresAt) return 'failed';
  return 'waiting';
}

export function encodePairingInvitation(input: {
  hostId?: string | null;
  preset: string;
  pairingId: string;
  pairingToken: string;
  expiresAt: string;
  reachability?: PairingReachability[];
  hostUrls?: string[];
}): string {
  const reachability =
    input.reachability?.filter((item) => !isLoopbackOrigin(item.origin)) ??
    (input.hostUrls ?? [])
      .filter((origin) => !isLoopbackOrigin(origin))
      .map((origin) => ({ origin, kind: 'lan' }));

  return `vibex-pairing:${JSON.stringify({
    version: 1,
    host_id: input.hostId || undefined,
    preset: input.preset,
    expires_at: input.expiresAt,
    pairing_id: input.pairingId,
    pairing_token: input.pairingToken,
    reachability,
  })}`;
}
