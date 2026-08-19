export type PairingReachability = {
  origin: string;
  kind: string;
};

export function isLoopbackOrigin(origin: string): boolean {
  return /127\.0\.0\.1|localhost|\[::1\]/i.test(origin);
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
