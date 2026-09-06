import { isLoopbackOrigin } from './pairingInvitation';

const DEFAULT_HOST_SERVICE_PORT = 17891;

function stripOriginScheme(origin: string): string {
  return origin.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function portFromOrigin(origin: string): number | null {
  try {
    const url = new URL(origin.includes('://') ? origin : `http://${origin}`);
    if (url.port) return Number(url.port);
    if (url.protocol === 'https:') return 443;
    return 80;
  } catch {
    return null;
  }
}

export function savedHostAddress(profile: {
  origin: string;
  provision?: Record<string, unknown> | null;
}): string {
  const provision = profile.provision;
  const host = typeof provision?.host === 'string' ? provision.host.trim() : '';
  if (host) {
    const servicePort = Number(provision?.servicePort);
    if (Number.isInteger(servicePort) && servicePort > 0) {
      return `${host}:${servicePort}`;
    }
    const addresses = Array.isArray(provision?.addresses)
      ? provision.addresses
      : [];
    for (const address of addresses) {
      if (typeof address !== 'string' || isLoopbackOrigin(address)) continue;
      const port = portFromOrigin(address);
      if (port && port !== 80 && port !== 443) {
        return `${host}:${port}`;
      }
    }
    return `${host}:${DEFAULT_HOST_SERVICE_PORT}`;
  }
  return stripOriginScheme(profile.origin);
}

export function savedHostOrigin(profile: {
  origin: string;
  provision?: Record<string, unknown> | null;
}): string {
  const origin = profile.origin?.trim().replace(/\/+$/, '') ?? '';
  if (origin && !isLoopbackOrigin(origin)) return origin;
  const address = savedHostAddress(profile);
  if (!address) return origin;
  if (address.includes('://')) return address.replace(/\/+$/, '');
  return `http://${address}`;
}

export function provisionKindLabel(
  kind: string | null | undefined,
  provisioners: { kind?: string | null; label: string }[] = []
): string | null {
  const value = kind?.trim();
  if (!value || value === 'manual' || value === 'discovered') {
    return null;
  }
  const match = provisioners.find((item) => item.kind === value);
  const label = match?.label?.trim();
  return label || value.toUpperCase();
}

export type SavedHostSource = 'discovered' | 'manual' | 'ssh' | 'other';

export function savedHostSource(
  kind: string | null | undefined
): SavedHostSource {
  const value = kind?.trim() ?? '';
  if (value === 'discovered') return 'discovered';
  if (value === 'ssh') return 'ssh';
  if (!value || value === 'manual') return 'manual';
  return 'other';
}
