import { isLoopbackOrigin } from './pairingInvitation';

export type HostEndpointKind = 'thisComputer' | 'lan' | 'published';

export type HostEndpoint = {
  origin: string;
  kind: HostEndpointKind;
};

export type RemoteAccessRowKind = 'browser' | HostEndpointKind;

export type RemoteAccessRow = {
  kind: RemoteAccessRowKind;
  origin: string;
  openHref: string;
};

function uniqueOrigins(
  address: string | null | undefined,
  addresses: string[] | undefined,
  reachability: Array<{ origin: string; kind: string }> | undefined
): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();
  const push = (origin: string | null | undefined) => {
    const value = origin?.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    origins.push(value);
  };
  for (const origin of addresses ?? []) push(origin);
  push(address);
  for (const item of reachability ?? []) push(item.origin);
  return origins;
}

export function hostEndpointsFromStatus(input: {
  address?: string | null;
  addresses?: string[];
  reachability?: Array<{ origin: string; kind: string }>;
}): HostEndpoint[] {
  const declaredKind = new Map(
    (input.reachability ?? []).map((item) => [item.origin, item.kind])
  );
  return uniqueOrigins(input.address, input.addresses, input.reachability).map(
    (origin) => {
      if (isLoopbackOrigin(origin)) {
        return { origin, kind: 'thisComputer' as const };
      }
      const declared = declaredKind.get(origin);
      if (declared && declared !== 'lan') {
        return { origin, kind: 'published' as const };
      }
      return { origin, kind: 'lan' as const };
    }
  );
}

export function defaultHostUrl(locationOrigin: string, search: string): string {
  return explicitHostUrl(search) ?? locationOrigin;
}

export function explicitHostUrl(search: string): string | null {
  const query = search.startsWith('?') ? search : `?${search}`;
  const params = new URLSearchParams(query);
  return params.get('host')?.trim() || params.get('server')?.trim() || null;
}

export async function looksLikeVibexHost(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const origin = baseUrl.trim().replace(/\/+$/, '');
  if (!origin) return false;
  try {
    const response = await fetchImpl(`${origin}/health`);
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return false;
    const body = (await response.json()) as { status?: unknown; ok?: unknown };
    return body.status === 'ok' || body.ok === true;
  } catch {
    return false;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left === right;
  }
}

function withHostQuery(frontendOrigin: string, hostOrigin: string): string {
  const url = new URL(frontendOrigin);
  url.searchParams.set('host', hostOrigin);
  return url.toString();
}

export function presentRemoteAccess(input: {
  running: boolean;
  servesWebUi?: boolean;
  address?: string | null;
  addresses?: string[];
  reachability?: Array<{ origin: string; kind: string }>;
  windowOrigin?: string;
}): RemoteAccessRow[] {
  if (!input.running) return [];

  const hostRows = hostEndpointsFromStatus(input);
  const hostLoopback =
    hostRows.find((row) => row.kind === 'thisComputer')?.origin ??
    input.address ??
    null;
  const windowOrigin = input.windowOrigin?.trim() || null;
  const frontendDiffers =
    !input.servesWebUi &&
    Boolean(windowOrigin) &&
    isLoopbackOrigin(windowOrigin!) &&
    Boolean(hostLoopback) &&
    !sameOrigin(windowOrigin!, hostLoopback!);

  if (!frontendDiffers) {
    return hostRows.map((row) => ({
      kind: row.kind,
      origin: row.origin,
      openHref: row.origin,
    }));
  }

  return [
    {
      kind: 'browser',
      origin: new URL(windowOrigin!).origin,
      openHref: withHostQuery(windowOrigin!, hostLoopback!),
    },
    ...hostRows.map((row) => ({
      kind: row.kind,
      origin: row.origin,
      openHref: row.origin,
    })),
  ];
}
