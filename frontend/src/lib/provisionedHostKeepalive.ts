export async function recoverBoundProvisionedHost(_input: {
  connected: boolean;
  profile: { id: string; provision_kind?: string | null } | null;
  probe: () => Promise<unknown>;
  connect: (profileId: string) => Promise<unknown>;
  notify: () => void;
}): Promise<'ok' | 'recovered' | 'skipped'> {
  return 'skipped';
}
